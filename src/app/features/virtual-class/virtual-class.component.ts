import { Component, OnInit } from '@angular/core';
import { PaginatePipe, PaginationComponent, Pager } from '../../shared/components/pagination.component';
import { CommonModule } from '@angular/common';
import { pickVideoUrl } from '../../core/utils/video-quality';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { DialogService } from '../../core/services/dialog.service';
import { AuthService } from '../../core/services/auth.service';
import { StudentPickerComponent, PickedStudent, studentsCsv, toPickedStudent } from '../../shared/components/student-picker.component';

interface VirtualClass {
  id: number;
  title: string;
  description: string;
  scheduledAt: string;
  durationMinutes: number;
  roomName: string;
  recordingUrl: string | null;
  recordingLightUrl?: string | null;
  status: string;
  teacherName: string | null;
  teacherId: number | null;
  courseTitle: string | null;
  thumbnailData: string | null;
  hasRecording: boolean;
  recordingLost?: boolean;
  guestCount?: number;
  sharedLinkActive?: boolean;
}

interface GuestInvite { id: number; name: string; email: string; link: string; active: boolean; emailSentAt: string | null; }
interface InvitesState { sharedLink: string | null; sharedLinkActive: boolean; guests: GuestInvite[]; }
interface InviteFailure { email: string; name: string; reason: string; }

@Component({
  selector: 'app-virtual-class',
  standalone: true,
  imports: [PaginationComponent, PaginatePipe, CommonModule, RouterLink, FormsModule, StudentPickerComponent],
  template: `
    <div class="fade-in-up">
      <div class="d-flex justify-content-between align-items-center mb-4">
        <div>
          <h1 class="fw-bold mb-1"><i class="bi bi-camera-video me-1"></i>Classes Virtuelles</h1>
          <p class="text-muted">Rejoignez des sessions en direct avec vos professeurs</p>
        </div>
        <div *ngIf="authService.isAdmin">
          <button class="btn btn-primary-custom" (click)="openCreate()">
            <i class="bi bi-plus-circle me-2"></i>Créer une session
          </button>
        </div>
      </div>

      <!-- Filtre par professeur (admin) -->
      <div *ngIf="authService.isAdmin && teacherOptions.length > 1" class="d-flex align-items-center gap-2 mb-3" style="max-width:420px">
        <label for="vc-teacher-filter" class="small fw-semibold text-nowrap mb-0"><i class="bi bi-person-video3 me-1"></i>Professeur</label>
        <select id="vc-teacher-filter" class="form-select form-select-sm" [(ngModel)]="teacherFilter" (ngModelChange)="classesPg.reset()">
          <option [ngValue]="null">Tous les professeurs</option>
          <option *ngFor="let t of teacherOptions" [ngValue]="t.id">{{ t.name }}</option>
        </select>
      </div>

      <!-- Tabs -->
      <ul class="nav nav-pills mb-4">
        <li class="nav-item">
          <button class="nav-link" [class.active]="activeTab === 'upcoming'" (click)="activeTab = 'upcoming'; classesPg.reset()">
            <i class="bi bi-calendar3 me-1"></i>À venir
          </button>
        </li>
        <li class="nav-item">
          <button class="nav-link" [class.active]="activeTab === 'ongoing'" (click)="activeTab = 'ongoing'; classesPg.reset()">
            <i class="bi bi-record-circle me-1"></i>En cours
          </button>
        </li>
        <li class="nav-item">
          <button class="nav-link" [class.active]="activeTab === 'past'" (click)="activeTab = 'past'; classesPg.reset()">
            <i class="bi bi-folder me-1"></i>Passées
          </button>
        </li>
      </ul>

      <!-- Loading -->
      <div *ngIf="loading" class="text-center py-5">
        <div class="spinner-border text-primary"></div>
      </div>

      <!-- Classe list -->
      <div class="row g-4" *ngIf="!loading">
        <div *ngIf="filteredClasses.length === 0" class="col-12 text-center py-5">
          <div style="font-size:4rem"><i class="bi bi-inbox"></i></div>
          <h4 class="mt-3">Aucune classe {{ getTabLabel() }}</h4>
        </div>

        <div class="col-md-6 col-xl-4" *ngFor="let vc of filteredClasses | paginate: classesPg.page : classesPg.size" [id]="'vc-' + vc.id">
          <div class="card border-0 shadow-sm h-100" style="border-radius:16px; overflow:hidden; transition: box-shadow .3s"
               [style.box-shadow]="highlightId === vc.id ? '0 0 0 3px #2b3ea8' : null">
            <!-- Status banner -->
            <div class="p-3 text-white text-center fw-semibold"
                 [style.background]="isOverdue(vc) ? '#94a3b8' : getStatusColor(vc.status)">
              <i class="me-2" [class.bi-clock]="vc.status === 'SCHEDULED' && !isOverdue(vc)"
                 [class.bi-exclamation-circle]="isOverdue(vc)"
                 [class.bi-record-circle]="vc.status === 'ONGOING'"
                 [class.bi-check-circle]="vc.status === 'COMPLETED'"></i>
              {{ isOverdue(vc) ? 'Non tenue' : getStatusLabel(vc.status) }}
            </div>

            <!-- Zone vidéo : toujours visible pour les sessions avec enregistrement -->
            <div *ngIf="vc.hasRecording" style="position:relative; background:#111; height:180px; overflow:hidden; cursor:pointer"
                 (click)="toggleInlinePlay(vc)">

              <!-- Miniature (si disponible) ou placeholder -->
              <ng-container *ngIf="playingVcId !== vc.id">
                <img *ngIf="vc.thumbnailData"
                     [src]="'data:image/jpeg;base64,' + vc.thumbnailData"
                     alt="miniature"
                     style="width:100%; height:100%; object-fit:cover; opacity:0.9; transition:opacity .2s">
                <div *ngIf="!vc.thumbnailData"
                     style="width:100%; height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; color:#555">
                  <i class="bi bi-camera-video" style="font-size:2.2rem"></i>
                  <span style="font-size:.75rem">Enregistrement disponible</span>
                </div>
              </ng-container>

              <!-- Lecteur vidéo inline -->
              <video *ngIf="playingVcId === vc.id && playingObjectUrl"
                     [src]="playingObjectUrl"
                     preload="metadata" playsinline
                     (click)="$event.stopPropagation()"
                     (canplay)="onVideoReady($event)"
                     (error)="onVideoError()"
                     (pause)="videoIsPaused = true"
                     (play)="videoIsPaused = false"
                     (ended)="videoIsPaused = true"
                     style="width:100%; height:100%; object-fit:contain; background:#000">
              </video>

              <!-- Spinner de chargement -->
              <div *ngIf="loadingVcId === vc.id"
                   style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,.65)">
                <div class="spinner-border text-light"></div>
              </div>

              <!-- Bouton Play / Pause YouTube-style -->
              <div *ngIf="loadingVcId !== vc.id"
                   style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center">
                <div style="background:rgba(0,0,0,.55); border-radius:50%; width:54px; height:54px;
                            display:flex; align-items:center; justify-content:center;
                            transition:background .15s; box-shadow:0 2px 8px rgba(0,0,0,.4)">
                  <i [class]="(playingVcId === vc.id && !videoIsPaused) ? 'bi bi-pause-fill' : 'bi bi-play-fill'"
                     style="color:#fff; font-size:1.5rem; margin-left:2px"></i>
                </div>
              </div>

              <!-- Plein écran -->
              <button *ngIf="playingVcId === vc.id && playingObjectUrl && loadingVcId !== vc.id"
                      type="button" title="Plein écran" aria-label="Afficher la vidéo en plein écran"
                      (click)="openFullscreen($event)"
                      style="position:absolute; right:8px; bottom:8px; z-index:2; border:0; border-radius:8px;
                             width:36px; height:36px; background:rgba(0,0,0,.6); color:#fff;
                             display:flex; align-items:center; justify-content:center">
                <i class="bi bi-arrows-fullscreen"></i>
              </button>
            </div>

            <div class="card-body p-4">
              <div class="d-flex justify-content-between align-items-start mb-2">
                <h5 class="fw-bold mb-0">{{ vc.title }}</h5>
                <button *ngIf="canDelete(vc)"
                        class="btn btn-sm btn-outline-danger ms-2"
                        title="Supprimer l'enregistrement"
                        (click)="$event.stopPropagation(); confirmDeleteRecording(vc)">
                  <i class="bi bi-trash"></i>
                </button>
              </div>
              <p class="text-muted small mb-3">{{ vc.description }}</p>

              <div class="d-flex flex-column gap-2 small text-muted mb-4">
                <div><i class="bi bi-calendar3 me-2 text-primary"></i>{{ vc.scheduledAt | date:'EEEE d MMMM y':'':'fr' }}</div>
                <div><i class="bi bi-clock me-2 text-primary"></i>{{ vc.scheduledAt | date:'HH:mm' }} · {{ vc.durationMinutes }}min</div>
                <div *ngIf="vc.teacherName"><i class="bi bi-person me-2 text-primary"></i>{{ vc.teacherName }}</div>
                <div *ngIf="vc.courseTitle"><i class="bi bi-book me-2 text-primary"></i>{{ vc.courseTitle }}</div>
              </div>

              <button *ngIf="vc.status === 'ONGOING'"
                      class="btn btn-danger fw-bold w-100"
                      (click)="joinRoom(vc.id)">
                <i class="bi bi-camera-video-fill me-2"></i>Rejoindre maintenant
              </button>
              <button *ngIf="vc.status === 'SCHEDULED' && !isOverdue(vc) && (authService.isTeacher || authService.isAdmin)"
                      class="btn btn-primary fw-bold w-100"
                      (click)="startSession(vc)">
                <i class="bi bi-play-circle me-2"></i>Démarrer la session
              </button>
              <button *ngIf="vc.status === 'SCHEDULED' && !isOverdue(vc) && authService.isStudent" class="btn btn-outline-primary w-100" disabled>
                <i class="bi bi-bell me-2"></i>Rappel activé
              </button>
              <div *ngIf="vc.status === 'SCHEDULED' && isOverdue(vc)" class="d-grid">
                <button *ngIf="authService.isTeacher || authService.isAdmin" class="btn btn-outline-primary w-100" (click)="startSession(vc)">
                  <i class="bi bi-play-circle me-2"></i>Démarrer en retard
                </button>
                <button *ngIf="authService.isStudent" class="btn btn-outline-secondary w-100" disabled>
                  <i class="bi bi-archive me-2"></i>Session non tenue
                </button>
              </div>
              <div *ngIf="vc.status === 'COMPLETED' && !vc.hasRecording && vc.recordingLost"
                   class="alert alert-warning small py-2 mb-0" role="status">
                <i class="bi bi-exclamation-triangle me-1"></i>
                Enregistrement perdu lors d'une mise à jour du serveur : la vidéo n'est plus disponible.
              </div>
              <div *ngIf="vc.status === 'COMPLETED' && !vc.hasRecording && !vc.recordingLost" class="d-grid">
                <button class="btn btn-outline-secondary w-100" disabled>
                  <i class="bi bi-archive me-2"></i>Session terminée (sans enregistrement)
                </button>
              </div>
              <button *ngIf="canSeeAttendance(vc) && vc.status !== 'COMPLETED' && vc.status !== 'CANCELLED'"
                      class="btn btn-outline-secondary w-100 mt-2" (click)="openInvites(vc)">
                <i class="bi bi-link-45deg me-2"></i>Lien de la séance
                <span *ngIf="vc.guestCount" class="badge bg-secondary ms-1">{{ vc.guestCount }}</span>
                <span *ngIf="vc.sharedLinkActive" class="badge bg-success ms-1" title="Lien partagé actif"><i class="bi bi-link"></i></span>
              </button>
              <a *ngIf="canSeeAttendance(vc) && (vc.status !== 'SCHEDULED' || isOverdue(vc))"
                 [routerLink]="['/virtual-class', vc.id, 'attendance']"
                 class="btn btn-outline-primary w-100 mt-2">
                <i class="bi bi-person-check me-2"></i>Présences et rapport
              </a>
              <!-- Admin : supprimer la séance, quel que soit l'onglet (à venir, en cours, passée) -->
              <button *ngIf="authService.isAdmin" type="button" class="btn btn-outline-danger w-100 mt-2"
                      [disabled]="deletingClassId === vc.id" (click)="deleteSession(vc)">
                <span *ngIf="deletingClassId === vc.id" class="spinner-border spinner-border-sm me-2"></span>
                <i *ngIf="deletingClassId !== vc.id" class="bi bi-trash3 me-2"></i>Supprimer la séance
              </button>
            </div>
          </div>
        </div>
      </div>
      <app-pagination [pager]="classesPg" [total]="filteredClasses.length"></app-pagination>

      <!-- How it works (if empty) -->
      <div *ngIf="!loading && classes.length === 0" class="mt-4">
        <div class="card border-0 bg-light p-5 rounded-4 text-center">
          <h4 class="fw-bold mb-4">Comment fonctionnent les classes virtuelles ?</h4>
          <div class="row g-4">
            <div class="col-md-3" *ngFor="let step of howItWorks">
              <div style="font-size:2.5rem"><i class="bi" [ngClass]="step.icon"></i></div>
              <h6 class="fw-bold mt-2">{{ step.title }}</h6>
              <p class="text-muted small">{{ step.desc }}</p>
            </div>
          </div>
        </div>
      </div>

      <!-- Create Modal -->
      <div class="modal fade show d-block" *ngIf="showCreateModal" style="background:rgba(0,0,0,.5);overflow-y:auto">
        <div class="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
          <div class="modal-content border-0 rounded-4">
            <div class="modal-header border-0 p-4">
              <h5 class="modal-title fw-bold"><i class="bi bi-calendar-event me-1"></i>Créer une classe virtuelle</h5>
              <button class="btn-close" (click)="showCreateModal = false"></button>
            </div>
            <div class="modal-body p-4">
              <div class="mb-3">
                <label class="form-label fw-semibold">Titre</label>
                <input type="text" class="form-control" [(ngModel)]="newClass.title" placeholder="Ex: Introduction à Java">
              </div>
              <div class="mb-3">
                <label class="form-label fw-semibold">Description</label>
                <textarea class="form-control" rows="3" [(ngModel)]="newClass.description"></textarea>
              </div>
              <div class="row g-3 mb-3">
                <div class="col-7">
                  <label class="form-label fw-semibold">Date et heure</label>
                  <input type="datetime-local" class="form-control" [(ngModel)]="newClass.scheduledAt">
                </div>
                <div class="col-5">
                  <label class="form-label fw-semibold">Durée (min)</label>
                  <input type="number" class="form-control" [(ngModel)]="newClass.durationMinutes" value="60">
                </div>
              </div>
              <div class="mb-3">
                <label class="form-label fw-semibold" for="vc-teacher">Professeur *</label>
                <select id="vc-teacher" class="form-select" [(ngModel)]="newTeacherId">
                  <option [ngValue]="null" disabled>Choisir le professeur qui anime la séance</option>
                  <option *ngFor="let t of teachers" [ngValue]="t.id">{{ t.firstName }} {{ t.lastName }} · {{ t.email }}</option>
                </select>
                <div *ngIf="teachersLoaded && !teachers.length" class="form-text text-danger">
                  Aucun compte professeur : créez-le d'abord depuis la gestion des utilisateurs.
                </div>
              </div>
              <div class="alert alert-light border small mb-3">
                <i class="bi bi-link-45deg me-1"></i>
                <strong>Un lien unique est créé pour la séance.</strong> Envoyez-le au professeur et aux étudiants
                (WhatsApp, email…) : le professeur, connecté à son compte, y entre en animateur ;
                les étudiants y entrent en tapant leur nom, sans compte.
              </div>
              <div class="mb-3">
                <label class="form-label fw-semibold">Étudiants avec compte <span class="fw-normal text-muted">(facultatif)</span></label>
                <app-student-picker [students]="newStudents" [targetLevels]="newLevels" [allowGuests]="true"></app-student-picker>
                <div class="form-text">La séance s'affiche aussi dans leur espace « Classes virtuelles ».</div>
              </div>
              <div *ngIf="createError" class="alert alert-danger py-2 mb-3 small">{{ createError }}</div>
              <div class="alert alert-info small mb-0">
                <i class="bi bi-info-circle me-1"></i>
                Un salon de visioconférence intégré sera généré automatiquement pour cette session,
                aucun lien externe n'est nécessaire.
              </div>
            </div>
            <div class="modal-footer border-0 p-4 pt-0">
              <button class="btn btn-outline-secondary" (click)="showCreateModal = false">Annuler</button>
              <button class="btn btn-primary-custom" (click)="createClass()">
                <i class="bi bi-check-circle me-2"></i>Créer la session
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Invitations sans compte -->
      <div class="modal fade show d-block" *ngIf="invitesFor" style="background:rgba(0,0,0,.5);overflow-y:auto" role="dialog" aria-modal="true">
        <div class="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
          <div class="modal-content border-0 rounded-4">
            <div class="modal-header border-0 p-4 pb-2">
              <div>
                <h5 class="modal-title fw-bold"><i class="bi bi-link-45deg me-1"></i>Lien de la séance</h5>
                <div class="small text-muted">{{ invitesFor.title }}</div>
              </div>
              <button class="btn-close" aria-label="Fermer" (click)="closeInvites()"></button>
            </div>
            <div class="modal-body p-4 pt-2">
              <div *ngIf="!invites" class="text-center py-4"><div class="spinner-border text-primary"></div></div>
              <div *ngIf="invitesError" class="alert alert-danger py-2 small">{{ invitesError }}</div>
              <div *ngIf="invitesNotice" class="alert alert-info py-2 small" style="white-space:pre-line">{{ invitesNotice }}</div>

              <ng-container *ngIf="invites">
                <!-- Lien partagé -->
                <h6 class="fw-bold mt-1"><i class="bi bi-share me-2 text-primary"></i>Lien à partager</h6>
                <p class="small text-muted mb-2">Le même lien pour le professeur et les étudiants. Le professeur, connecté à son compte,
                  y entre en animateur ; les étudiants entrent en tapant leur nom, sans compte, et apparaissent dans les présences comme « invité ».</p>
                <ng-container *ngIf="invites.sharedLink && invites.sharedLinkActive; else noLink">
                  <div class="input-group mb-2">
                    <input class="form-control" [value]="invites.sharedLink" readonly aria-label="Lien d'invitation partagé" (focus)="$any($event.target).select()">
                    <button class="btn btn-primary" (click)="copy(invites.sharedLink!)"><i class="bi bi-clipboard me-1"></i>Copier</button>
                  </div>
                  <div class="d-flex flex-wrap gap-2 mb-4">
                    <a class="btn btn-sm btn-success" target="_blank" rel="noopener" [href]="whatsappUrl(invites.sharedLink!)">
                      <i class="bi bi-whatsapp me-1"></i>Envoyer par WhatsApp</a>
                    <button class="btn btn-sm btn-outline-secondary" [disabled]="invitesBusy" (click)="regenerateLink()">
                      <i class="bi bi-arrow-repeat me-1"></i>Nouveau lien</button>
                    <button class="btn btn-sm btn-outline-danger" [disabled]="invitesBusy" (click)="disableLink()">
                      <i class="bi bi-slash-circle me-1"></i>Désactiver</button>
                  </div>
                </ng-container>
                <ng-template #noLink>
                  <button class="btn btn-outline-primary mb-4" [disabled]="invitesBusy" (click)="enableLink()">
                    <i class="bi bi-link me-1"></i>{{ invites.sharedLink ? 'Réactiver le lien' : 'Créer le lien' }}</button>
                </ng-template>

                <!-- Invitations personnelles -->
                <h6 class="fw-bold border-top pt-3"><i class="bi bi-envelope me-2 text-primary"></i>Invitations personnelles par email</h6>
                <p class="small text-muted mb-2">Chaque personne reçoit son propre lien : on sait qui est entré, et ses présences et appels sont suivis à son nom.</p>
                <form class="row g-2 align-items-end mb-2" (ngSubmit)="addGuest()">
                  <div class="col-sm-5">
                    <label class="form-label small mb-1" for="guest-name">Nom</label>
                    <input id="guest-name" name="guestName" class="form-control form-control-sm" [(ngModel)]="guestName" placeholder="Prénom Nom">
                  </div>
                  <div class="col-sm-5">
                    <label class="form-label small mb-1" for="guest-email">Email</label>
                    <input id="guest-email" name="guestEmail" type="email" class="form-control form-control-sm" [(ngModel)]="guestEmail" placeholder="nom@exemple.com">
                  </div>
                  <div class="col-sm-2 d-grid">
                    <button type="submit" class="btn btn-sm btn-primary" [disabled]="invitesBusy || !guestEmail.trim()">Inviter</button>
                  </div>
                </form>
                <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
                  <button class="btn btn-sm btn-outline-primary" [disabled]="invitesBusy" (click)="guestFile.click()">
                    <span *ngIf="invitesBusy" class="spinner-border spinner-border-sm me-1"></span>
                    <i *ngIf="!invitesBusy" class="bi bi-upload me-1"></i>Importer une liste</button>
                  <span class="small text-muted">Excel, CSV, Word ou PDF avec les colonnes Nom et Email.</span>
                  <input #guestFile type="file" accept=".xlsx,.xls,.csv,.pdf,.docx,.doc" style="display:none" (change)="importGuests($event)">
                </div>

                <div *ngIf="!invites.guests.length" class="small text-muted">Aucune invitation personnelle pour le moment.</div>
                <div *ngIf="invites.guests.length" class="table-responsive" style="max-height:300px">
                  <table class="table table-sm align-middle mb-0">
                    <thead class="table-light sticky-top"><tr><th>Nom</th><th>Email</th><th>Envoi</th><th class="text-end">Actions</th></tr></thead>
                    <tbody>
                      <tr *ngFor="let g of invites.guests">
                        <td class="small">{{ g.name }}</td>
                        <td class="small text-muted">{{ g.email }}</td>
                        <td class="small">
                          <span *ngIf="g.emailSentAt" class="text-success"><i class="bi bi-check2 me-1"></i>{{ g.emailSentAt | date:'dd/MM HH:mm' }}</span>
                          <span *ngIf="!g.emailSentAt" class="text-danger"><i class="bi bi-exclamation-circle me-1"></i>non envoyé</span>
                        </td>
                        <td class="text-end text-nowrap">
                          <button class="btn btn-sm btn-link p-1" title="Copier son lien" [attr.aria-label]="'Copier le lien de ' + g.name" (click)="copy(g.link)"><i class="bi bi-clipboard"></i></button>
                          <button class="btn btn-sm btn-link p-1" title="Renvoyer l'email" [attr.aria-label]="'Renvoyer l’email à ' + g.name" [disabled]="invitesBusy" (click)="resendGuest(g)"><i class="bi bi-envelope-arrow-up"></i></button>
                          <button class="btn btn-sm btn-link p-1 text-danger" title="Retirer" [attr.aria-label]="'Retirer ' + g.name" [disabled]="invitesBusy" (click)="removeGuest(g)"><i class="bi bi-x-circle"></i></button>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </ng-container>
            </div>
            <div class="modal-footer border-0 p-4 pt-0">
              <button class="btn btn-outline-secondary" (click)="closeInvites()">Fermer</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Erreur inline player -->
      <div *ngIf="inlineError" class="alert alert-danger mt-3">
        <i class="bi bi-exclamation-circle me-2"></i>{{ inlineError }}
        <button class="btn-close float-end" (click)="inlineError=''"></button>
      </div>

      <!-- Confirm Delete Modal -->
      <div class="modal fade show d-block" *ngIf="deletingRecording" style="background:rgba(0,0,0,.5)">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content border-0 rounded-4">
            <div class="modal-body p-4 text-center">
              <div style="font-size:2.5rem"><i class="bi bi-trash3"></i></div>
              <h5 class="fw-bold mt-2">Supprimer l'enregistrement ?</h5>
              <p class="text-muted">Cette action est irréversible. La vidéo sera définitivement supprimée.</p>
              <div class="d-flex gap-2 justify-content-center mt-3">
                <button class="btn btn-outline-secondary" (click)="deletingRecording = null">Annuler</button>
                <button class="btn btn-danger" (click)="deleteRecording()" [disabled]="deleteLoading">
                  <span *ngIf="deleteLoading" class="spinner-border spinner-border-sm me-1"></span>
                  Supprimer
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `
})
export class VirtualClassComponent implements OnInit {
  /** Pagination des listes. */
  classesPg = new Pager(9);
  classes: VirtualClass[] = [];
  loading = true;
  activeTab = 'upcoming';
  showCreateModal = false;
  deletingRecording: VirtualClass | null = null;
  deleteLoading = false;
  newClass: any = { title: '', description: '', scheduledAt: '', durationMinutes: 60 };
  newStudents: PickedStudent[] = [];
  newLevels = new Set<string>();
  newTeacherId: number | null = null;
  teachers: { id: number; firstName: string; lastName: string; email: string }[] = [];
  teachersLoaded = false;
  createError = '';

  // Invitations sans compte (lien partagé, invitations personnelles)
  invitesFor: VirtualClass | null = null;
  invites: InvitesState | null = null;
  invitesBusy = false;
  invitesError = '';
  invitesNotice = '';
  guestName = '';
  guestEmail = '';

  // Inline player state
  playingVcId: number | null = null;
  loadingVcId: number | null = null;
  playingObjectUrl: string | null = null;
  videoIsPaused = true;
  inlineError = '';
  private currentVideoEl: HTMLVideoElement | null = null;

  howItWorks = [
    { icon: 'bi-calendar-event', title: 'Planifiez', desc: 'Les professeurs planifient des sessions en direct' },
    { icon: 'bi-camera-video', title: 'Rejoignez', desc: 'La visioconférence est intégrée à la plateforme, en un clic' },
    { icon: '⏺️', title: 'Enregistrez', desc: "Le professeur peut enregistrer la session" },
    { icon: 'bi-folder', title: 'Revoyez', desc: "Le cours enregistré reste disponible dans l'onglet Passées" }
  ];

  /** Professeur choisi dans le filtre (admin) ; null : tous. */
  teacherFilter: number | null = null;

  /** Professeurs des séances, pour le filtre. */
  get teacherOptions(): { id: number; name: string }[] {
    const byId = new Map<number, string>();
    this.classes.forEach(vc => { if (vc.teacherId != null) byId.set(vc.teacherId, vc.teacherName || 'Professeur'); });
    return [...byId].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  }

  get filteredClasses(): VirtualClass[] {
    let now = new Date();
    return this.classes.filter(vc => {
      if (this.teacherFilter !== null && vc.teacherId !== this.teacherFilter) return false;
      if (this.activeTab === 'ongoing') return vc.status === 'ONGOING';
      // « À venir » tant que la séance n'est pas finie ; une fois l'heure de fin passée sans démarrage : « Non tenue » (Passées)
      if (this.activeTab === 'upcoming') return vc.status === 'SCHEDULED' && !this.isOverdue(vc);
      if (this.activeTab === 'past') return vc.status === 'COMPLETED' || this.isOverdue(vc);
      return true;
    });
  }

  /** Séance ouverte depuis le tableau de bord (?session=id), mise en évidence */
  highlightId: number | null = null;

  constructor(private http: HttpClient, private router: Router, private route: ActivatedRoute, public authService: AuthService,
              private dialogs: DialogService) {}

  ngOnInit() {
    const params = this.route.snapshot.queryParamMap;
    const tab = params.get('tab');
    if (tab === 'upcoming' || tab === 'ongoing' || tab === 'past') this.activeTab = tab;
    const session = Number(params.get('session')) || null;
    this.http.get<VirtualClass[]>('/api/virtual-classes').subscribe({
      next: (data) => { this.classes = data; this.loading = false; if (session) this.showSession(session); },
      error: () => {
        // Liste vide plutôt que des séances fictives : chacun ne voit que ses propres séances
        this.classes = [];
        this.loading = false;
      }
    });
  }

  /** Ouvre l'onglet et la page de la liste où se trouve la séance, puis la fait défiler à l'écran. */
  private showSession(id: number) {
    const vc = this.classes.find(c => c.id === id);
    if (!vc) return;
    this.activeTab = vc.status === 'ONGOING' ? 'ongoing' : (vc.status === 'COMPLETED' || this.isOverdue(vc)) ? 'past' : 'upcoming';
    const index = this.filteredClasses.findIndex(c => c.id === id);
    this.classesPg.page = Math.floor(Math.max(0, index) / this.classesPg.size) + 1;
    this.highlightId = id;
    setTimeout(() => document.getElementById('vc-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
    setTimeout(() => this.highlightId = null, 4000);
  }

  isOverdue(vc: VirtualClass): boolean {
    if (vc.status !== 'SCHEDULED') return false;
    const end = new Date(vc.scheduledAt).getTime() + (vc.durationMinutes || 0) * 60000;
    return end < Date.now();
  }

  /** Rapport de présence : professeur de la séance ou administrateur. */
  canSeeAttendance(vc: VirtualClass): boolean {
    if (this.authService.isAdmin) return true;
    const currentUserId = this.authService.currentUser?.id;
    return !!(this.authService.isTeacher && currentUserId && vc.teacherId === currentUserId);
  }

  canDelete(vc: VirtualClass): boolean {
    if (!vc.hasRecording) return false;
    if (this.authService.isAdmin) return true;
    const currentUserId = this.authService.currentUser?.id;
    return !!(this.authService.isTeacher && currentUserId && vc.teacherId === currentUserId);
  }

  getTabLabel() { return { upcoming: 'à venir', ongoing: 'en cours', past: 'passée' }[this.activeTab] || ''; }
  getStatusLabel(s: string) { return { SCHEDULED: 'Planifiée', ONGOING: 'En direct', COMPLETED: 'Terminée', CANCELLED: 'Annulée' }[s] || s; }
  getStatusColor(s: string) { return { SCHEDULED: '#2b3ea8', ONGOING: '#ef4444', COMPLETED: '#10b981', CANCELLED: '#94a3b8' }[s] || '#2b3ea8'; }

  joinRoom(id: number) { this.router.navigate(['/virtual-class', id, 'room']); }

  toggleInlinePlay(vc: VirtualClass) {
    if (!vc.hasRecording) return;
    // En plein écran, les clics sur la barre de lecture native ne doivent pas relancer ou mettre en pause la vidéo
    if (document.fullscreenElement) return;

    if (this.playingVcId === vc.id) {
      // Même vidéo : toggle play/pause
      if (this.currentVideoEl) {
        if (this.videoIsPaused) {
          this.currentVideoEl.play();
        } else {
          this.currentVideoEl.pause();
        }
      }
      return;
    }

    // Nouvelle vidéo : arrêter la précédente et charger
    this.stopCurrentVideo();
    this.inlineError = '';
    this.playingVcId = vc.id;
    this.loadingVcId = vc.id;
    this.videoIsPaused = true;

    // Enregistrement en fichier : lecture en streaming (démarre tout de suite, version légère si la connexion est faible)
    const url = pickVideoUrl(vc.recordingUrl, vc.recordingLightUrl);
    if (url && !url.startsWith('/api/')) {
      this.playingObjectUrl = url;
      return;
    }
    // Ancien enregistrement encore stocké en base : téléchargement avec le jeton de connexion
    this.http.get(`/api/virtual-classes/${vc.id}/recording`, { responseType: 'blob' }).subscribe({
      next: (blob) => {
        this.playingObjectUrl = URL.createObjectURL(blob);
      },
      error: () => {
        this.loadingVcId = null;
        this.playingVcId = null;
        this.inlineError = 'Impossible de charger la vidéo.';
      }
    });
  }

  onVideoError() {
    this.stopCurrentVideo();
    this.inlineError = 'Impossible de lire la vidéo. Vérifiez votre connexion puis réessayez.';
  }

  onVideoReady(event: Event) {
    // « canplay » revient après chaque avance rapide : on ne relance la lecture qu'à l'ouverture
    if (this.currentVideoEl === event.target) return;
    this.loadingVcId = null;
    this.currentVideoEl = event.target as HTMLVideoElement;
    this.currentVideoEl.play();
    this.videoIsPaused = false;
  }

  /** Vidéo en plein écran, avec la barre de lecture native (avance, retour, volume) pour bien la revoir. */
  openFullscreen(event: Event) {
    event.stopPropagation();
    const video = this.currentVideoEl;
    if (!video) return;
    video.controls = true;
    const iosVideo = video as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
    if (video.requestFullscreen) {
      const onChange = () => {
        if (document.fullscreenElement) return;
        video.controls = false;
        document.removeEventListener('fullscreenchange', onChange);
      };
      document.addEventListener('fullscreenchange', onChange);
      video.requestFullscreen().catch(() => {
        video.controls = false;
        document.removeEventListener('fullscreenchange', onChange);
      });
    } else if (iosVideo.webkitEnterFullscreen) {
      // iPhone : pas d'API plein écran standard sur les vidéos
      video.addEventListener('webkitendfullscreen', () => { video.controls = false; }, { once: true });
      iosVideo.webkitEnterFullscreen();
    }
  }

  private stopCurrentVideo() {
    if (this.currentVideoEl) {
      this.currentVideoEl.pause();
      this.currentVideoEl = null;
    }
    if (this.playingObjectUrl) {
      if (this.playingObjectUrl.startsWith('blob:')) URL.revokeObjectURL(this.playingObjectUrl);
      this.playingObjectUrl = null;
    }
    this.playingVcId = null;
    this.loadingVcId = null;
    this.videoIsPaused = true;
  }

  confirmDeleteRecording(vc: VirtualClass) { this.deletingRecording = vc; }

  deletingClassId: number | null = null;

  /** Admin : supprime la séance entière (enregistrement, présences et lien compris). */
  async deleteSession(vc: VirtualClass) {
    const live = vc.status === 'ONGOING' ? ' Elle est en direct : les participants seront déconnectés du lien.' : '';
    const ok = await this.dialogs.confirmDelete('la séance « ' + vc.title + ' »',
      'Son enregistrement, ses présences et son lien seront supprimés définitivement.' + live);
    if (!ok) return;
    if (this.playingVcId === vc.id) this.stopCurrentVideo();
    this.deletingClassId = vc.id;
    this.http.delete(`/api/admin/virtual-classes/${vc.id}`).subscribe({
      next: () => {
        this.classes = this.classes.filter(c => c.id !== vc.id);
        this.deletingClassId = null;
        this.dialogs.toast('Séance supprimée.');
      },
      error: e => {
        this.deletingClassId = null;
        this.dialogs.toast(e.error?.message || 'Impossible de supprimer la séance.', 'danger');
      }
    });
  }

  deleteRecording() {
    if (!this.deletingRecording) return;
    this.deleteLoading = true;
    const vc = this.deletingRecording;
    this.http.delete<VirtualClass>(`/api/teacher/virtual-classes/${vc.id}/recording`).subscribe({
      next: (updated) => {
        const idx = this.classes.findIndex(c => c.id === vc.id);
        if (idx !== -1) this.classes[idx] = { ...this.classes[idx], ...updated };
        this.deleteLoading = false;
        this.deletingRecording = null;
      },
      error: () => {
        this.deleteLoading = false;
        this.deletingRecording = null;
      }
    });
  }

  startSession(vc: VirtualClass) {
    this.http.put<VirtualClass>(`/api/teacher/virtual-classes/${vc.id}/status`, {}, { params: { status: 'ONGOING' } }).subscribe({
      next: () => { vc.status = 'ONGOING'; this.joinRoom(vc.id); },
      error: () => { this.joinRoom(vc.id); }
    });
  }

  openCreate() {
    this.showCreateModal = true;
    this.createError = '';
    if (this.teachersLoaded) return;
    this.http.get<{ id: number; firstName: string; lastName: string; email: string }[]>('/api/admin/users/teachers').subscribe({
      next: list => {
        this.teachers = [...list].sort((a, b) => `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`, 'fr'));
        this.teachersLoaded = true;
      },
      error: () => { this.createError = 'Impossible de charger la liste des professeurs.'; }
    });
  }

  createClass() {
    if (!this.newTeacherId) {
      this.createError = 'Choisissez le professeur qui anime la séance.';
      return;
    }
    const formData = new FormData();
    const data = { ...this.newClass, targetLevels: [...this.newLevels].join(',') };
    formData.append('class', new Blob([JSON.stringify(data)], { type: 'application/json' }));
    if (this.newStudents.length) formData.append('studentList', studentsCsv(this.newStudents));
    formData.append('teacherId', String(this.newTeacherId));
    this.http.post<VirtualClass>('/api/teacher/virtual-classes', formData).subscribe({
      next: (vc) => {
        this.classes.unshift(vc);
        this.showCreateModal = false;
        this.newClass = { title: '', description: '', scheduledAt: '', durationMinutes: 60 };
        this.newStudents = [];
        this.newLevels = new Set();
        this.newTeacherId = null;
        this.createError = '';
        // Le lien unique à envoyer au professeur et aux étudiants
        this.openInvites(vc);
      },
      error: (e) => { this.createError = e.error?.message || 'Impossible de créer la session. Vérifiez les informations et la liste des étudiants.'; }
    });
  }

  // --- Invitations sans compte ---

  openInvites(vc: VirtualClass) {
    this.invitesFor = vc;
    this.invites = null;
    this.invitesError = '';
    this.invitesNotice = '';
    this.http.get<InvitesState>(`/api/teacher/virtual-classes/${vc.id}/invites`).subscribe({
      next: st => this.setInvites(st),
      error: e => this.invitesError = e.error?.message || 'Impossible de charger les invitations.'
    });
  }

  closeInvites() { this.invitesFor = null; this.invites = null; }

  private setInvites(st: InvitesState) {
    this.invites = st;
    if (this.invitesFor) {
      this.invitesFor.guestCount = st.guests.length;
      this.invitesFor.sharedLinkActive = !!st.sharedLink && st.sharedLinkActive;
    }
  }

  private invitesCall(request: Observable<any>, done?: () => void) {
    this.invitesBusy = true;
    this.invitesError = '';
    request.subscribe({
      next: (st: any) => { this.invitesBusy = false; this.setInvites(st); done?.(); },
      error: e => { this.invitesBusy = false; this.invitesError = e.error?.message || 'Action impossible. Réessayez.'; }
    });
  }

  enableLink() {
    this.invitesCall(this.http.post(`/api/teacher/virtual-classes/${this.invitesFor!.id}/invites/link`, {}));
  }

  async regenerateLink() {
    const ok = await this.dialogs.confirm({ title: 'Créer un nouveau lien ?', tone: 'warning', confirmText: 'Nouveau lien',
      message: 'L\'ancien lien n\'ouvrira plus la séance. Il faudra partager le nouveau.' });
    if (!ok) return;
    this.invitesCall(this.http.post(`/api/teacher/virtual-classes/${this.invitesFor!.id}/invites/link`, {}, { params: { regenerate: 'true' } }),
      () => this.dialogs.toast('Nouveau lien créé.'));
  }

  async disableLink() {
    const ok = await this.dialogs.confirm({ title: 'Désactiver le lien ?', tone: 'danger', confirmText: 'Désactiver',
      message: 'Plus personne ne pourra entrer avec ce lien. Les invitations personnelles restent valables.' });
    if (!ok) return;
    this.invitesCall(this.http.delete(`/api/teacher/virtual-classes/${this.invitesFor!.id}/invites/link`));
  }

  addGuest() {
    if (!this.guestEmail.trim()) return;
    this.sendGuests([{ name: this.guestName.trim(), email: this.guestEmail.trim() }], () => { this.guestName = ''; this.guestEmail = ''; });
  }

  /** Liste importée (même lecture que pour les étudiants), puis invitations envoyées. */
  importGuests(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.invitesBusy = true;
    this.invitesError = '';
    this.invitesNotice = '';
    const fd = new FormData();
    fd.append('file', file);
    this.http.post<any>('/api/teacher/qcms/parse-students', fd).subscribe({
      next: res => {
        this.invitesBusy = false;
        const people = (res.students || []).map((x: any) => toPickedStudent(x))
          .filter((p: PickedStudent) => p.email.trim())
          .map((p: PickedStudent) => ({ name: `${p.firstName} ${p.lastName}`.trim() || p.name, email: p.email.trim() }));
        if (!people.length) { this.invitesError = 'Aucune personne avec un email trouvée dans ce fichier.'; return; }
        this.sendGuests(people);
      },
      error: err => {
        this.invitesBusy = false;
        this.invitesError = err.error?.error || err.error?.message || 'Erreur lors de la lecture du fichier.';
      }
    });
  }

  private sendGuests(guests: { name: string; email: string }[], done?: () => void) {
    this.invitesBusy = true;
    this.invitesError = '';
    this.invitesNotice = '';
    this.http.post<{ invites: InvitesState; added: number; skipped: InviteFailure[]; emailFailed: InviteFailure[] }>(
      `/api/teacher/virtual-classes/${this.invitesFor!.id}/invites/guests`, { guests }).subscribe({
      next: r => {
        this.invitesBusy = false;
        this.setInvites(r.invites);
        const lines = [`${r.added} invitation(s) créée(s).`];
        if (r.emailFailed.length) lines.push(`Email non envoyé à ${r.emailFailed.length} personne(s) : ${r.emailFailed[0].reason}. Copiez leur lien ou renvoyez l'email.`);
        if (r.skipped.length) lines.push(`Écartées : ${r.skipped.map(f => `${f.email || f.name} (${f.reason})`).join(' ; ')}`);
        this.invitesNotice = lines.join('\n');
        if (r.added && !r.emailFailed.length) this.dialogs.toast(`${r.added} invitation(s) envoyée(s) par email.`);
        done?.();
      },
      error: e => { this.invitesBusy = false; this.invitesError = e.error?.message || 'Invitations non créées. Réessayez.'; }
    });
  }

  resendGuest(g: GuestInvite) {
    this.invitesCall(this.http.post(`/api/teacher/virtual-classes/${this.invitesFor!.id}/invites/guests/${g.id}/resend`, {}),
      () => this.dialogs.toast(`Email renvoyé à ${g.email}.`));
  }

  async removeGuest(g: GuestInvite) {
    const ok = await this.dialogs.confirm({ title: `Retirer ${g.name} ?`, tone: 'danger', confirmText: 'Retirer',
      message: 'Son lien personnel n\'ouvrira plus la séance.' });
    if (!ok) return;
    this.invitesCall(this.http.delete(`/api/teacher/virtual-classes/${this.invitesFor!.id}/invites/guests/${g.id}`));
  }

  copy(text: string) {
    navigator.clipboard?.writeText(text).then(
      () => this.dialogs.toast('Lien copié.'),
      () => this.dialogs.toast('Copie impossible : sélectionnez le lien et copiez-le.', 'warning'));
  }

  whatsappUrl(link: string): string {
    const title = this.invitesFor?.title ?? 'Classe virtuelle';
    return 'https://wa.me/?text=' + encodeURIComponent(`Classe virtuelle « ${title} » : rejoignez la séance ici ${link}`);
  }
}
