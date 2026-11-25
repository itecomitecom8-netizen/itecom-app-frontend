import { Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { HttpClient, HttpContext, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { SILENT_ERRORS } from '../../core/interceptors/error.interceptor';
import { DialogService } from '../../core/services/dialog.service';
import { checkMicrophone } from './microphone-check';
import { AuthService } from '../../core/services/auth.service';

declare const JitsiMeetExternalAPI: any;

interface InviteInfo {
  title: string; description: string | null; scheduledAt: string | null; durationMinutes: number | null;
  teacherName: string | null; status: string; shared: boolean; guestName: string | null;
  canJoin: boolean; message: string | null;
  /** Le visiteur connecté anime la séance (professeur ou admin) : il entre dans la salle complète. */
  hostClassId: number | null;
}

interface JoinResponse { token: string; domain: string; roomName: string; displayName: string; attendanceId: number; }

const SESSION_KEY = 'itecom-guest-session';
const NAME_KEY = 'itecom-guest-name';

/**
 * Classe virtuelle ouverte par un lien d'invitation, sans compte ni connexion :
 * lien partagé de la séance (l'invité saisit son nom) ou invitation personnelle reçue par email.
 */
@Component({
  selector: 'app-virtual-class-guest',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  template: `
    <div class="guest-page">
      <header class="guest-header">
        <span class="fw-bold"><i class="bi bi-mortarboard-fill me-2"></i>ITECOM</span>
        <span class="small opacity-75">Classe virtuelle</span>
      </header>

      <div *ngIf="loading" class="text-center py-5"><div class="spinner-border text-primary"></div></div>

      <div *ngIf="!loading && notFound" class="guest-card text-center">
        <div class="display-6 mb-2"><i class="bi bi-link-45deg"></i></div>
        <h1 class="h4 fw-bold">Lien introuvable</h1>
        <p class="text-muted mb-0">Ce lien d'invitation n'existe pas ou a été supprimé. Demandez un nouveau lien au professeur.</p>
      </div>

      <ng-container *ngIf="!loading && info">
        <!-- Avant l'entrée -->
        <div *ngIf="!inRoom && !left" class="guest-card">
          <h1 class="h4 fw-bold mb-1">{{ info.title }}</h1>
          <p *ngIf="info.description" class="text-muted mb-3">{{ info.description }}</p>
          <ul class="list-unstyled small text-muted d-flex flex-column gap-1 mb-4">
            <li *ngIf="info.scheduledAt"><i class="bi bi-calendar3 me-2 text-primary"></i>{{ info.scheduledAt | date:'EEEE d MMMM y, HH:mm':'':'fr' }}
              <span *ngIf="info.durationMinutes"> · {{ info.durationMinutes }} min</span></li>
            <li *ngIf="info.teacherName"><i class="bi bi-person me-2 text-primary"></i>{{ info.teacherName }}</li>
          </ul>

          <div *ngIf="!info.canJoin" class="alert mb-0 d-flex gap-2" [ngClass]="waiting ? 'alert-info' : 'alert-secondary'" role="status">
            <i class="bi" [ngClass]="waiting ? 'bi-hourglass-split' : 'bi-info-circle'"></i>
            <div>
              <div>{{ info.message }}</div>
              <div *ngIf="waiting" class="small mt-1 opacity-75">Vérification automatique toutes les 15 secondes.</div>
            </div>
          </div>

          <form *ngIf="info.canJoin" (ngSubmit)="join()" class="d-flex flex-column gap-3">
            <div *ngIf="info.shared">
              <label for="guest-name" class="form-label fw-semibold">Votre prénom et nom</label>
              <input id="guest-name" name="name" class="form-control form-control-lg" [(ngModel)]="name"
                     autocomplete="name" maxlength="80" required placeholder="Ex : Awa Diop">
              <div class="form-text">Ce nom est affiché au professeur et aux autres participants.</div>
            </div>
            <p *ngIf="!info.shared" class="mb-0">Bonjour <strong>{{ info.guestName }}</strong>, vous pouvez entrer dans la séance.</p>
            <div *ngIf="error" class="alert alert-danger py-2 mb-0 small">{{ error }}</div>
            <button type="submit" class="btn btn-primary btn-lg fw-semibold" [disabled]="joining || (info.shared && name.trim().length < 2)">
              <span *ngIf="joining" class="spinner-border spinner-border-sm me-2"></span>
              <i *ngIf="!joining" class="bi bi-camera-video-fill me-2"></i>Rejoindre la classe
            </button>
            <p class="small text-muted mb-0">Autorisez la caméra et le micro quand le navigateur le demande. Aucun compte n'est nécessaire.</p>
          </form>

          <p *ngIf="!auth.isAuthenticated" class="small text-muted mt-4 mb-0 pt-3 border-top">
            <i class="bi bi-person-video3 me-1"></i>Vous êtes le professeur de cette séance ?
            <a routerLink="/auth/login" [queryParams]="{ returnUrl: '/classe/' + token }">Connectez-vous</a>
            pour l'animer avec ce même lien.
          </p>
        </div>

        <!-- Dans la salle -->
        <div *ngIf="inRoom" class="guest-room">
          <div class="d-flex flex-wrap align-items-center gap-2 mb-2">
            <h1 class="h6 fw-bold mb-0 flex-grow-1">{{ info.title }}</h1>
            <span class="small text-muted"><i class="bi bi-person-circle me-1"></i>{{ displayName }}</span>
            <button class="btn btn-sm btn-outline-secondary" (click)="leave()"><i class="bi bi-box-arrow-right me-1"></i>Quitter</button>
          </div>
          <div *ngIf="!joinedConference" class="alert alert-info small py-2">
            Si une fenêtre « Rejoindre la réunion » s'affiche dans la vidéo, cliquez dessus pour entrer.
          </div>
          <div #jitsiContainer class="guest-video shadow-sm"></div>
        </div>

        <div *ngIf="left" class="guest-card text-center">
          <div class="display-6 mb-2"><i class="bi bi-check-circle text-success"></i></div>
          <h2 class="h5 fw-bold">Vous avez quitté la séance</h2>
          <button class="btn btn-outline-primary mt-2" (click)="rejoin()">Revenir dans la séance</button>
        </div>
      </ng-container>
    </div>
  `,
  styles: [`
    .guest-page { min-height: 100vh; background: #f4f6fb; padding-bottom: 24px; }
    .guest-header { display: flex; justify-content: space-between; align-items: center; padding: 14px 20px;
      background: linear-gradient(135deg, #0b2a6f, #1d6ff2); color: #fff; }
    .guest-card { max-width: 560px; margin: 32px auto 0; background: #fff; border-radius: 16px; padding: 28px;
      box-shadow: 0 4px 18px rgba(15, 23, 42, .08); }
    .guest-room { padding: 16px; }
    .guest-video { width: 100%; height: calc(100vh - 150px); min-height: 360px; border-radius: 12px; overflow: hidden; background: #111; }
    @media (max-width: 576px) { .guest-card { margin: 16px; padding: 20px; } .guest-room { padding: 8px; } }
  `]
})
export class VirtualClassGuestComponent implements OnInit, OnDestroy {
  @ViewChild('jitsiContainer') jitsiContainer?: ElementRef<HTMLDivElement>;

  token = '';
  info: InviteInfo | null = null;
  loading = true;
  notFound = false;
  name = '';
  joining = false;
  error = '';
  inRoom = false;
  joinedConference = false;
  private micChecked = false;
  left = false;
  displayName = '';

  private session = '';
  private attendanceId: number | null = null;
  private jitsiApi: any;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private waitPoll: ReturnType<typeof setInterval> | null = null;
  private rollCallPoll: ReturnType<typeof setInterval> | null = null;
  private answeringCallId: number | null = null;
  private readonly silent = { context: new HttpContext().set(SILENT_ERRORS, true) };

  constructor(private route: ActivatedRoute, private router: Router, private http: HttpClient,
              private dialogs: DialogService, public auth: AuthService) {}

  get waiting(): boolean {
    return !!this.info && !this.info.canJoin && this.info.status === 'SCHEDULED';
  }

  ngOnInit() {
    this.token = this.route.snapshot.paramMap.get('token') || '';
    this.session = this.loadSession();
    this.name = this.readStorage(NAME_KEY) || '';
    this.loadInfo();
  }

  @HostListener('window:beforeunload')
  beforeUnload() { this.sendLeave(true); }

  ngOnDestroy() {
    this.stopTimers();
    this.sendLeave();
    try { this.jitsiApi?.dispose(); } catch { /* déjà fermé */ }
  }

  private get base(): string { return `/api/public/virtual-classes/invite/${encodeURIComponent(this.token)}`; }
  private get sessionParams(): HttpParams { return new HttpParams().set('session', this.session); }

  private loadInfo() {
    this.http.get<InviteInfo>(this.base, this.silent).subscribe({
      next: info => {
        // Professeur connecté : même lien, mais il entre en animateur (démarrage, enregistrement, appel)
        if (info.hostClassId) {
          this.router.navigate(['/virtual-class', info.hostClassId, 'room'], { replaceUrl: true });
          return;
        }
        this.info = info;
        this.loading = false;
        // Séance pas encore démarrée : la page s'actualise seule
        if (this.waiting && !this.waitPoll) this.waitPoll = setInterval(() => this.refreshInfo(), 15_000);
      },
      error: () => { this.loading = false; this.notFound = true; }
    });
  }

  private refreshInfo() {
    this.http.get<InviteInfo>(this.base, this.silent).subscribe({
      next: info => {
        this.info = info;
        if (!this.waiting && this.waitPoll) { clearInterval(this.waitPoll); this.waitPoll = null; }
      },
      error: () => {}
    });
  }

  async join() {
    if (!this.info || this.joining) return;
    this.joining = true;
    this.error = '';
    // Micro vérifié avant d'entrer : explications claires s'il est bloqué (une seule fois par page)
    if (!this.micChecked) {
      this.micChecked = true;
      await checkMicrophone(this.dialogs);
    }
    if (this.info.shared) this.writeStorage(NAME_KEY, this.name.trim());
    try {
      const res = await firstValueFrom(this.http.post<JoinResponse>(`${this.base}/join`,
        { name: this.info.shared ? this.name : null, session: this.session }, this.silent));
      this.attendanceId = res.attendanceId;
      this.displayName = res.displayName;
      this.inRoom = true;
      this.left = false;
      this.joining = false;
      setTimeout(() => this.startConference(res), 0);
      this.heartbeat = setInterval(() => {
        if (!this.attendanceId) return;
        this.http.post(`${this.base}/attendance/${this.attendanceId}/heartbeat`, {},
          { ...this.silent, params: this.sessionParams }).subscribe({ error: () => {} });
      }, 30_000);
      this.checkRollCall();
      this.rollCallPoll = setInterval(() => this.checkRollCall(), 15_000);
    } catch (e: any) {
      this.joining = false;
      this.error = e?.error?.message || 'Impossible de rejoindre la séance. Vérifiez votre connexion puis réessayez.';
      if (e?.status === 409) this.refreshInfo();
    }
  }

  rejoin() { this.join(); }

  leave() {
    this.sendLeave();
    this.stopTimers();
    try { this.jitsiApi?.dispose(); } catch { /* déjà fermé */ }
    this.jitsiApi = null;
    this.inRoom = false;
    this.joinedConference = false;
    this.left = true;
  }

  private async startConference(res: JoinResponse) {
    try {
      await this.loadJitsiScript(res.domain);
      if (!this.jitsiContainer) return;
      this.jitsiApi = new JitsiMeetExternalAPI(res.domain, {
        roomName: res.roomName,
        jwt: res.token,
        parentNode: this.jitsiContainer.nativeElement,
        width: '100%',
        height: '100%',
        userInfo: { displayName: res.displayName },
        configOverwrite: {
          prejoinPageEnabled: false,
          // Image en HD (720p) quand la connexion le permet ; écran partagé net
          resolution: 720,
          constraints: { video: { height: { ideal: 720, max: 720, min: 240 } } },
          desktopSharingFrameRate: { min: 5, max: 15 },
          prejoinConfig: { enabled: false },
          requireDisplayName: false,
          lobby: { enabled: false },
          hideLobbyButton: true,
          disableDeepLinking: true
        }
      });
      this.jitsiApi.addListener('videoConferenceJoined', () => { this.joinedConference = true; });
      this.jitsiApi.addListener('readyToClose', () => this.leave());
    } catch {
      this.error = 'Impossible de charger la visioconférence. Rechargez la page.';
      this.inRoom = false;
    }
  }

  private loadJitsiScript(domain: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (typeof JitsiMeetExternalAPI !== 'undefined') { resolve(); return; }
      const script = document.createElement('script');
      script.src = `https://${domain}/external_api.js`;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Jitsi indisponible'));
      document.body.appendChild(script);
    });
  }

  /** Appel du professeur : « Je suis présent ». */
  private checkRollCall() {
    if (this.answeringCallId) return;
    this.http.get<{ id: number; secondsLeft: number } | null>(`${this.base}/roll-calls/active`,
      { ...this.silent, params: this.sessionParams }).subscribe({
      next: call => {
        if (!call || this.answeringCallId) return;
        this.answeringCallId = call.id;
        this.dialogs.alert({
          title: 'Appel du professeur', icon: 'bi-person-raised-hand', tone: 'warning', confirmText: 'Je suis présent',
          message: `Confirmez votre présence dans les ${Math.ceil(call.secondsLeft / 60)} minute(s).`
        }).then(() => {
          this.http.post(`${this.base}/roll-calls/${call.id}/answer`, {}, { ...this.silent, params: this.sessionParams }).subscribe({
            next: () => { this.answeringCallId = null; this.dialogs.toast('Présence confirmée.'); },
            error: err => { this.answeringCallId = null; this.dialogs.toast(err.error?.message || 'Présence non enregistrée.', 'danger'); }
          });
        });
      },
      error: () => {}
    });
  }

  /** @param unloading page en cours de fermeture : envoi en keepalive pour que la requête aboutisse. */
  private sendLeave(unloading = false) {
    if (!this.attendanceId) return;
    const url = `${this.base}/attendance/${this.attendanceId}/leave?session=${encodeURIComponent(this.session)}`;
    this.attendanceId = null;
    if (unloading) {
      fetch(url, { method: 'POST', keepalive: true }).catch(() => {});
    } else {
      this.http.post(url, {}, this.silent).subscribe({ error: () => {} });
    }
  }

  private stopTimers() {
    [this.heartbeat, this.waitPoll, this.rollCallPoll].forEach(t => t && clearInterval(t));
    this.heartbeat = this.waitPoll = this.rollCallPoll = null;
  }

  /** Identifiant propre à ce navigateur : reconnecté, l'invité garde la même présence. */
  private loadSession(): string {
    const existing = this.readStorage(SESSION_KEY);
    if (existing && /^[A-Za-z0-9-]{8,64}$/.test(existing)) return existing;
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const session = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    this.writeStorage(SESSION_KEY, session);
    return session;
  }

  private readStorage(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
  }

  private writeStorage(key: string, value: string) {
    try { localStorage.setItem(key, value); } catch { /* navigation privée : identifiant valable pour cette page */ }
  }
}
