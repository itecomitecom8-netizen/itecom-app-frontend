import { Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink, ActivatedRoute, Router } from '@angular/router';
import { HttpClient, HttpContext } from '@angular/common/http';
import { SILENT_ERRORS } from '../../core/interceptors/error.interceptor';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { DialogService } from '../../core/services/dialog.service';
import { checkMicrophone } from './microphone-check';

declare const JitsiMeetExternalAPI: any;

interface VirtualClass {
  id: number;
  title: string;
  description: string;
  scheduledAt: string;
  durationMinutes: number;
  roomName: string;
  recordingUrl: string | null;
  status: string;
  teacherName: string | null;
  courseTitle: string | null;
}

interface RollCallLine { name: string; email: string; status: 'PRESENT' | 'NO_ANSWER' | 'NOT_CONNECTED'; answeredAt: string | null; }

interface RollCall {
  id: number; startedAt: string; expiresAt: string; open: boolean;
  expected: number; present: number; noAnswer: number; notConnected: number; students: RollCallLine[];
}

interface JitsiTokenResponse {
  token: string;
  domain: string;
  /** Nom affiché dans la salle, « (Professeur) » pour le professeur de la séance. */
  displayName?: string;
  roomName: string;
}

@Component({
  selector: 'app-virtual-class-room',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <!-- Fin de séance dans moins de 2 minutes : chrono pour le professeur / l'administrateur -->
    <div *ngIf="isTeacher && endCountdown !== null" class="end-countdown shadow-lg" role="alert" aria-live="assertive">
      <div class="d-flex align-items-center gap-2 mb-1">
        <i class="bi bi-stopwatch fs-4"></i>
        <strong>Fin de la séance</strong>
      </div>
      <div class="end-countdown-time">{{ endCountdownLabel }}</div>
      <div class="small">
        La durée prévue ({{ vc?.durationMinutes }} min) est presque atteinte : la séance se terminera automatiquement.
        <span *ngIf="recording">L'enregistrement sera arrêté et sauvegardé dans l'onglet « Passées ».</span>
      </div>
    </div>

    <div class="fade-in-up">
      <div class="d-flex align-items-center gap-3 mb-3">
        <a routerLink="/virtual-class" class="btn btn-outline-secondary btn-sm">
          <i class="bi bi-arrow-left"></i>
        </a>
        <div>
          <h2 class="fw-bold mb-0">{{ vc?.title || 'Classe virtuelle' }}</h2>
          <p class="text-muted mb-0 small">{{ vc?.description }}</p>
        </div>
      </div>

      <div *ngIf="loading" class="text-center py-5">
        <div class="spinner-border text-primary"></div>
      </div>

      <div *ngIf="!loading && vc">
        <div *ngIf="isTeacher && joinNotifications.length > 0" class="alert alert-success d-flex flex-column gap-1 py-2">
          <div *ngFor="let n of joinNotifications"><i class="bi bi-person-check-fill me-2"></i><strong>{{ n }}</strong> a rejoint la session.</div>
        </div>

        <!-- Rappel toutes les 20 minutes : faire l'appel -->
        <div *ngIf="isTeacher && reminderDue && !activeRollCall?.open" class="alert alert-warning d-flex flex-wrap align-items-center gap-2 shadow-sm roll-call-reminder" role="alert">
          <i class="bi bi-exclamation-triangle-fill fs-4"></i>
          <div class="flex-grow-1">
            <div class="fw-bold">Il est temps de faire l'appel</div>
            <div class="small">Vérifiez que tous les étudiants sont bien là : un appel toutes les {{ reminderMinutes }} minutes.</div>
          </div>
          <button class="btn btn-warning fw-semibold" [disabled]="rollCallBusy" (click)="startRollCall()">
            <i class="bi bi-person-raised-hand me-1"></i>Faire l'appel maintenant</button>
          <button class="btn btn-outline-secondary btn-sm" (click)="snoozeReminder()">Dans 5 minutes</button>
        </div>

        <div *ngIf="isTeacher && joined" class="card border-0 shadow-sm mb-3">
          <div class="card-body py-3">
            <div class="d-flex flex-wrap align-items-center gap-3">
              <span class="fw-semibold"><i class="bi bi-person-raised-hand me-2 text-primary"></i>Appel des étudiants</span>
              <button class="btn btn-sm btn-primary" [disabled]="rollCallBusy || activeRollCall?.open" (click)="startRollCall()">
                <span *ngIf="rollCallBusy" class="spinner-border spinner-border-sm me-1"></span>
                <i *ngIf="!rollCallBusy" class="bi bi-bell me-1"></i>Faire l'appel</button>
              <span *ngIf="!activeRollCall?.open" class="small text-muted"><i class="bi bi-alarm me-1"></i>Prochain rappel dans {{ nextReminderLabel }}</span>
              <span *ngIf="activeRollCall?.open" class="small text-muted"><i class="bi bi-hourglass-split me-1"></i>Appel en cours : {{ rollCallSecondsLeft }} s pour répondre</span>
            </div>

            <div *ngIf="activeRollCall as rc" class="mt-3">
              <div class="d-flex flex-wrap gap-2 mb-2 small">
                <span class="status-badge ok">{{ rc.present }} présent(s)</span>
                <span class="status-badge warn">{{ rc.noAnswer }} connecté(s) sans réponse</span>
                <span class="status-badge danger">{{ rc.notConnected }} non connecté(s)</span>
                <span class="text-muted">sur {{ rc.expected }} étudiant(s) · appel de {{ rc.startedAt | date:'HH:mm' }}</span>
                <button *ngIf="!rc.open" type="button" class="btn btn-link btn-sm p-0 ms-auto" (click)="activeRollCall = null">Masquer</button>
              </div>
              <div class="d-flex flex-wrap gap-2">
                <span *ngFor="let l of rc.students" class="badge border py-2 px-3 d-flex align-items-center gap-1"
                      [ngClass]="l.status === 'PRESENT' ? 'bg-success-subtle text-success-emphasis' : l.status === 'NO_ANSWER' ? 'bg-warning-subtle text-warning-emphasis' : 'bg-light text-muted'"
                      [title]="l.status === 'PRESENT' ? 'A répondu à ' + (l.answeredAt | date:'HH:mm:ss') : l.status === 'NO_ANSWER' ? 'Connecté, sans réponse' : 'Pas connecté'">
                  <i class="bi" [ngClass]="l.status === 'PRESENT' ? 'bi-check-circle-fill' : l.status === 'NO_ANSWER' ? 'bi-question-circle' : 'bi-x-circle'"></i>{{ l.name || l.email }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div *ngIf="isTeacher" class="card border-0 shadow-sm mb-3">
          <div class="card-body d-flex align-items-center gap-3 py-3">
            <span class="fw-semibold"><i class="bi bi-record-circle me-2 text-danger"></i>Enregistrement de la session</span>
            <button class="btn btn-sm btn-danger" *ngIf="!recording" (click)="startRecording()">
              <i class="bi bi-record-circle me-1"></i>Démarrer l'enregistrement
            </button>
            <button class="btn btn-sm btn-outline-danger" *ngIf="recording" (click)="confirmStopRecording()">
              <i class="bi bi-stop-circle me-1"></i>Arrêter l'enregistrement
            </button>
            <span *ngIf="recording" class="badge bg-danger">
              <i class="bi bi-record-circle-fill me-1"></i>Enregistrement en cours...
            </span>
            <button class="btn btn-sm btn-outline-secondary" *ngIf="hasSomethingRecorded && !uploading && !ending"
                    (click)="discardRecording()" [disabled]="discarding">
              <span *ngIf="discarding" class="spinner-border spinner-border-sm me-1"></span>
              <i *ngIf="!discarding" class="bi bi-trash3 me-1"></i>Supprimer l'enregistrement
            </button>
            <span *ngIf="recording && lastSavedAt" class="text-success small" title="Le cours est envoyé à la plateforme pendant l'enregistrement">
              <i class="bi bi-cloud-check me-1"></i>Sauvegardé automatiquement à {{ lastSavedAt | date:'HH:mm:ss' }}
            </span>
            <span *ngIf="uploading" class="text-muted small">
              <span class="spinner-border spinner-border-sm me-1"></span>Envoi de l'enregistrement...
            </span>
            <button class="btn btn-sm btn-outline-secondary" (click)="endSession()" [disabled]="ending">
              <span *ngIf="ending" class="spinner-border spinner-border-sm me-1"></span>
              <i *ngIf="!ending" class="bi bi-box-arrow-right me-1"></i>
              {{ ending ? "Sauvegarde de l'enregistrement..." : 'Terminer la session' }}
            </button>
          </div>
        </div>

        <div *ngIf="isTeacher" class="card border-0 shadow-sm mb-3">
          <div class="card-body py-3">
            <h6 class="fw-bold mb-2">
              <i class="bi bi-people-fill me-2 text-primary"></i>Participants connectés
              <span class="badge bg-primary ms-1">{{ connectedParticipants.length }}</span>
            </h6>
            <div *ngIf="connectedParticipants.length === 0" class="text-muted small">
              Aucun étudiant connecté pour le moment.
            </div>
            <div class="d-flex flex-wrap gap-2">
              <span class="badge bg-light text-dark border d-flex align-items-center gap-1 py-2 px-3" *ngFor="let p of connectedParticipants">
                <i class="bi bi-person-circle text-success"></i>{{ p.name }}
              </span>
            </div>
          </div>
        </div>

        <div *ngIf="uploadSuccess" class="alert alert-success">
          <i class="bi bi-check-circle me-2"></i>Cours enregistré dans la plateforme. Vous le retrouverez dans l'onglet « Passées » des Classes virtuelles une fois la séance terminée.
        </div>
        <div *ngIf="uploadError" class="alert alert-danger">
          <i class="bi bi-exclamation-circle me-2"></i>{{ uploadError }}
        </div>

        <div *ngIf="!joined" class="alert alert-info d-flex flex-wrap align-items-center gap-2">
          <i class="bi bi-info-circle me-2"></i>
          <span class="flex-grow-1">
            Si une fenêtre <strong>"Rejoindre la réunion" / "Join Meeting"</strong> s'affiche dans la vidéo ci-dessous
            (avec les réglages caméra/micro), cliquez dessus pour entrer dans la session.
          </span>
          <button *ngIf="showReload" class="btn btn-sm btn-outline-primary" (click)="reloadConference()">
            <i class="bi bi-arrow-clockwise me-1"></i>Recharger la visioconférence
          </button>
        </div>

        <details *ngIf="!isTeacher" class="small text-muted mb-2">
          <summary><i class="bi bi-mic me-1"></i>On ne vous entend pas ?</summary>
          <ul class="mb-0 mt-1 ps-3">
            <li>Gardez l'écran allumé et cette page ouverte : en veille ou dans une autre application, le téléphone coupe le micro.</li>
            <li>Vérifiez le micro choisi : flèche <strong>^</strong> à côté du bouton micro, en bas de la vidéo.</li>
            <li>Après un appel WhatsApp ou téléphonique, rechargez la page.</li>
            <li>Connexion faible : coupez votre caméra, le son passera mieux.</li>
          </ul>
        </details>
        <div #jitsiContainer style="width:100%; height:75vh; border-radius:12px; overflow:hidden" class="shadow-sm"></div>

        <details class="mt-3">
          <summary class="text-muted small">Diagnostic technique (en cas de problème de connexion)</summary>
          <div class="bg-dark text-light p-2 mt-1 rounded small" style="font-family:monospace; max-height:200px; overflow:auto">
            <div *ngFor="let line of debugLog">{{ line }}</div>
          </div>
        </details>
      </div>
    </div>
  `,
  styles: [`
    .end-countdown {
      position: fixed; left: 20px; bottom: 20px; z-index: 2000; width: 300px;
      background: #b91c1c; color: #fff; border-radius: 14px; padding: 14px 16px;
      animation: pulse-end 1s ease-in-out infinite alternate;
    }
    .end-countdown-time { font-size: 2.4rem; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; margin-bottom: 4px; }
    @keyframes pulse-end { from { box-shadow: 0 0 0 0 rgba(185,28,28,.6); } to { box-shadow: 0 0 0 10px rgba(185,28,28,0); } }
    .roll-call-reminder { position: sticky; top: 72px; z-index: 5; border-left: 6px solid #b4690e; }
  `]
})
export class VirtualClassRoomComponent implements OnInit, OnDestroy {
  @ViewChild('jitsiContainer', { static: false }) jitsiContainer!: ElementRef<HTMLDivElement>;

  vc: VirtualClass | null = null;
  loading = true;
  recording = false;
  uploading = false;
  uploadSuccess = false;
  uploadError = '';
  knockingParticipants: { id: string; name: string }[] = [];
  connectedParticipants: { id: string; name: string }[] = [];
  joinNotifications: string[] = [];
  debugLog: string[] = [];
  joined = false;
  showReload = false;
  ending = false;

  private joinTimeoutHandle: any;

  // Présence : une connexion enregistrée côté serveur, confirmée toutes les 30 s
  private attendanceId: number | null = null;
  private attendanceHeartbeat: ReturnType<typeof setInterval> | null = null;
  private static readonly HEARTBEAT_MS = 30000;

  // Appel : rappel au professeur toutes les 20 minutes, réponse « Je suis présent » des étudiants
  readonly reminderMinutes = 20;
  reminderDue = false;
  nextReminderAt = 0;
  activeRollCall: RollCall | null = null;
  rollCallBusy = false;
  private now = Date.now();
  private reminderTicker: ReturnType<typeof setInterval> | null = null;
  private rollCallPoll: ReturnType<typeof setInterval> | null = null;
  private studentCallPoll: ReturnType<typeof setInterval> | null = null;
  private answeringCallId: number | null = null;

  private jitsiApi: any;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];

  // Sauvegarde pendant le cours : un morceau envoyé toutes les 20 s, dans l'ordre, renvoyé en cas de coupure
  private static readonly CHUNK_MS = 20000;
  private chunkSeq = 0;
  private chunkQueue: { seq: number; blob: Blob }[] = [];
  private chunkSending = false;
  /** Le serveur n'a pas pu suivre les morceaux : à la fin, la vidéo complète est envoyée d'un coup. */
  private chunkFailed = false;
  private chunkWaiters: (() => void)[] = [];
  lastSavedAt: Date | null = null;

  // Fin automatique : à l'heure prévue + durée (ou, séance lancée après cette heure, à l'entrée + durée)
  private static readonly WARN_BEFORE_END_MS = 2 * 60 * 1000;
  private endAt = 0;
  private endTicker: ReturnType<typeof setInterval> | null = null;
  private autoEnded = false;
  /** Secondes restantes, affichées dans le chrono des 2 dernières minutes ; null en dehors. */
  endCountdown: number | null = null;

  get endCountdownLabel(): string {
    const s = Math.max(0, this.endCountdown ?? 0);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }
  private displayStream: MediaStream | null = null;
  private micStream: MediaStream | null = null;
  private recordingAudioCtx: AudioContext | null = null;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private http: HttpClient,
    public authService: AuthService,
    private dialogs: DialogService
  ) {}

  get isTeacher(): boolean {
    return this.authService.isTeacher || this.authService.isAdmin;
  }

  ngOnInit() {
    const id = this.route.snapshot.paramMap.get('id');
    this.http.get<VirtualClass>(`/api/virtual-classes/${id}`).subscribe({
      next: (data) => {
        this.vc = data;
        this.loading = false;
        setTimeout(() => this.initJitsi(), 0);
        this.startEndTimer();
      },
      error: () => { this.loading = false; }
    });
  }

  /**
   * Si l'enseignant ferme l'onglet/le navigateur pendant un enregistrement,
   * la page est déchargée immédiatement : onstop() ne se déclenche jamais
   * et l'enregistrement est perdu sans avertissement. On bloque donc la
   * fermeture tant que l'enregistrement est en cours ou en cours d'envoi.
   */
  @HostListener('window:beforeunload', ['$event'])
  beforeUnload(event: BeforeUnloadEvent) {
    // Dernier morceau envoyé tout de suite : on perd au plus quelques secondes si la page se ferme
    if (this.recording && this.mediaRecorder?.state === 'recording') this.mediaRecorder.requestData();
    this.leaveAttendance(true);
    if (this.recording || this.uploading) {
      event.preventDefault();
      event.returnValue = '';
    }
  }

  ngOnDestroy() {
    if (this.endTicker) clearInterval(this.endTicker);
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    this.displayStream?.getTracks().forEach(t => t.stop());
    clearTimeout(this.joinTimeoutHandle);
    this.stopRollCallTimers();
    this.leaveAttendance();
    this.jitsiApi?.dispose();
  }

  // --- Appel ---

  get nextReminderLabel(): string {
    const s = Math.max(0, Math.round((this.nextReminderAt - this.now) / 1000));
    return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
  }

  get rollCallSecondsLeft(): number {
    return this.activeRollCall ? Math.max(0, Math.round((new Date(this.activeRollCall.expiresAt).getTime() - this.now) / 1000)) : 0;
  }

  /** Démarre le rappel (professeur) ou l'écoute des appels (étudiant) une fois dans la salle. */
  private startRollCallTimers() {
    if (this.isTeacher) {
      if (this.reminderTicker) return;
      this.nextReminderAt = Date.now() + this.reminderMinutes * 60_000;
      this.reminderTicker = setInterval(() => {
        this.now = Date.now();
        if (!this.reminderDue && !this.activeRollCall?.open && this.now >= this.nextReminderAt) this.raiseReminder();
      }, 1000);
    } else if (!this.studentCallPoll) {
      this.checkStudentRollCall();
      this.studentCallPoll = setInterval(() => this.checkStudentRollCall(), 15_000);
    }
  }

  private stopRollCallTimers() {
    [this.reminderTicker, this.rollCallPoll, this.studentCallPoll].forEach(t => t && clearInterval(t));
    this.reminderTicker = this.rollCallPoll = this.studentCallPoll = null;
  }

  /** Avertissement : bandeau, son et notification du navigateur si l'onglet n'est pas affiché. */
  private raiseReminder() {
    this.reminderDue = true;
    this.beep();
    this.dialogs.toast('Rappel : faites l\'appel pour vérifier que tout le monde est là.', 'warning', 8000);
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      new Notification('ITECOM — Faire l\'appel', { body: `${this.vc?.title ?? 'Classe virtuelle'} : vérifiez que tous les étudiants sont là.` });
    }
  }

  snoozeReminder() {
    this.reminderDue = false;
    this.nextReminderAt = Date.now() + 5 * 60_000;
  }

  startRollCall() {
    if (!this.vc || this.rollCallBusy) return;
    // Autorise les notifications du navigateur pour les prochains rappels (onglet en arrière-plan)
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
    this.rollCallBusy = true;
    this.http.post<RollCall>(`/api/teacher/virtual-classes/${this.vc.id}/roll-calls`, {}).subscribe({
      next: rc => {
        this.rollCallBusy = false;
        this.activeRollCall = rc;
        this.reminderDue = false;
        this.nextReminderAt = Date.now() + this.reminderMinutes * 60_000;
        this.dialogs.toast('Appel lancé : les étudiants connectés doivent confirmer leur présence.', 'info');
        if (this.rollCallPoll) clearInterval(this.rollCallPoll);
        this.rollCallPoll = setInterval(() => this.refreshRollCall(), 4000);
      },
      error: err => { this.rollCallBusy = false; this.dialogs.toast(err.error?.message || 'Impossible de lancer l\'appel.', 'danger'); }
    });
  }

  private refreshRollCall() {
    if (!this.vc || !this.activeRollCall) return;
    this.http.get<RollCall>(`/api/teacher/virtual-classes/${this.vc.id}/roll-calls/${this.activeRollCall.id}`,
      { context: new HttpContext().set(SILENT_ERRORS, true) }).subscribe({
      next: rc => {
        this.activeRollCall = rc;
        if (!rc.open && this.rollCallPoll) {
          clearInterval(this.rollCallPoll);
          this.rollCallPoll = null;
          const missing = rc.noAnswer + rc.notConnected;
          this.dialogs.toast(missing ? `Appel terminé : ${rc.present} présent(s), ${missing} sans réponse.` : 'Appel terminé : tout le monde est là.',
            missing ? 'warning' : 'success', 6000);
        }
      },
      error: () => {}
    });
  }

  /** Étudiant : si un appel est ouvert, demande « Je suis présent ». */
  private checkStudentRollCall() {
    if (!this.vc || this.answeringCallId) return;
    const classId = this.vc.id;
    this.http.get<{ id: number; secondsLeft: number } | null>(`/api/virtual-classes/${classId}/roll-calls/active`,
      { context: new HttpContext().set(SILENT_ERRORS, true) }).subscribe({
      next: call => {
        if (!call || this.answeringCallId) return;
        this.answeringCallId = call.id;
        this.beep();
        this.dialogs.alert({
          title: 'Appel du professeur', icon: 'bi-person-raised-hand', tone: 'warning', confirmText: 'Je suis présent',
          message: `Confirmez votre présence dans les ${Math.ceil(call.secondsLeft / 60)} minute(s). Sans réponse, vous serez noté(e) absent(e) à cet appel.`
        }).then(() => {
          this.http.post(`/api/virtual-classes/${classId}/roll-calls/${call.id}/answer`, {}).subscribe({
            next: () => { this.answeringCallId = null; this.dialogs.toast('Présence confirmée.'); },
            error: err => { this.answeringCallId = null; this.dialogs.toast(err.error?.message || 'Présence non enregistrée.', 'danger'); }
          });
        });
      },
      error: () => {}
    });
  }

  /** Court signal sonore pour attirer l'attention. */
  private beep() {
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.6);
      osc.onended = () => ctx.close();
    } catch { /* son indisponible : le bandeau suffit */ }
  }

  // --- Présence ---

  private joinAttendance() {
    if (!this.vc || this.attendanceId) return;
    const classId = this.vc.id;
    this.http.post<{ attendanceId: number }>(`/api/virtual-classes/${classId}/attendance/join`, {},
      { context: new HttpContext().set(SILENT_ERRORS, true) }).subscribe({
      next: r => {
        this.attendanceId = r.attendanceId;
        this.attendanceHeartbeat = setInterval(() => {
          if (!this.attendanceId) return;
          this.http.post(`/api/virtual-classes/${classId}/attendance/${this.attendanceId}/heartbeat`, {},
            { context: new HttpContext().set(SILENT_ERRORS, true) }).subscribe({ error: () => {} });
        }, VirtualClassRoomComponent.HEARTBEAT_MS);
      },
      error: () => this.log('Présence non enregistrée (erreur serveur)')
    });
  }

  /** @param unloading page en cours de fermeture : envoi en keepalive pour que la requête aboutisse. */
  private leaveAttendance(unloading = false) {
    if (this.attendanceHeartbeat) { clearInterval(this.attendanceHeartbeat); this.attendanceHeartbeat = null; }
    if (!this.vc || !this.attendanceId) return;
    const url = `/api/virtual-classes/${this.vc.id}/attendance/${this.attendanceId}/leave`;
    this.attendanceId = null;
    if (unloading) {
      const token = this.authService.getToken();
      fetch(url, { method: 'POST', keepalive: true, headers: token ? { Authorization: `Bearer ${token}` } : {} }).catch(() => {});
    } else {
      this.http.post(url, {}, { context: new HttpContext().set(SILENT_ERRORS, true) }).subscribe({ error: () => {} });
    }
  }

  reloadConference() {
    this.log('Rechargement manuel de la visioconférence...');
    this.showReload = false;
    this.joined = false;
    clearTimeout(this.joinTimeoutHandle);
    try { this.jitsiApi?.dispose(); } catch { /* ignore */ }
    this.jitsiApi = null;
    this.connectedParticipants = [];
    this.knockingParticipants = [];
    setTimeout(() => this.initJitsi(), 100);
  }

  private loadJitsiScript(domain: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (typeof JitsiMeetExternalAPI !== 'undefined') {
        resolve();
        return;
      }
      const script = document.createElement('script');
      script.src = `https://${domain}/external_api.js`;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Impossible de charger Jitsi Meet'));
      document.body.appendChild(script);
    });
  }

  private micChecked = false;

  private async initJitsi() {
    if (!this.vc) return;
    // Micro vérifié avant d'entrer : explications claires s'il est bloqué (une seule fois par page)
    if (!this.micChecked) {
      this.micChecked = true;
      await checkMicrophone(this.dialogs);
    }
    try {
      this.log('Demande du jeton sécurisé Jitsi...');
      const jitsi = await firstValueFrom(
        this.http.get<JitsiTokenResponse>(`/api/virtual-classes/${this.vc.id}/jitsi-token`)
      );
      this.log('Jeton obtenu. Chargement de Jitsi...');
      await this.loadJitsiScript(jitsi.domain);
      this.log('Script chargé. Création de la salle "' + jitsi.roomName + '"...');
      const user = this.authService.currentUser;
      this.jitsiApi = new JitsiMeetExternalAPI(jitsi.domain, {
        roomName: jitsi.roomName,
        jwt: jitsi.token,
        parentNode: this.jitsiContainer.nativeElement,
        width: '100%',
        height: '100%',
        userInfo: {
          displayName: jitsi.displayName || (user ? `${user.firstName} ${user.lastName}` : 'Utilisateur')
        },
        configOverwrite: {
          prejoinPageEnabled: false,
          // Professeur en HD (720p) ; étudiants en 360p pour que leur son passe même sur une petite connexion.
          // Le partage d'écran reste net (réglé à part).
          resolution: this.isTeacher ? 720 : 360,
          constraints: { video: this.isTeacher
            ? { height: { ideal: 720, max: 720, min: 240 } }
            : { height: { ideal: 360, max: 360, min: 180 } } },
          desktopSharingFrameRate: { min: 5, max: 15 },
          prejoinConfig: { enabled: false },
          requireDisplayName: false,
          lobby: { enabled: false },
          hideLobbyButton: true,
          enableLobbyChat: false,
          disableDeepLinking: true
        }
      });

      // Si l'embed reste bloqué sur l'écran de pré-connexion de meet.jit.si
      // (videoConferenceJoined jamais déclenché), on propose un bouton pour
      // recharger l'iframe, qui résout parfois le blocage.
      this.showReload = false;
      clearTimeout(this.joinTimeoutHandle);
      this.joinTimeoutHandle = setTimeout(() => {
        if (!this.joined) {
          this.log('Toujours pas connecté après 8s, affichage du bouton de rechargement.');
          this.showReload = true;
        }
      }, 8000);

      this.jitsiApi.addListener('videoConferenceJoined', (event: any) => {
        this.joined = true;
        this.showReload = false;
        clearTimeout(this.joinTimeoutHandle);
        this.log('videoConferenceJoined : ' + (event?.displayName || '') + ' (id=' + event?.id + ')');
        this.joinAttendance();
        this.startRollCallTimers();
        // Récupère les participants déjà présents dans le salon au moment
        // où le professeur ouvre la page (ex: étudiants connectés avant lui).
        const existing = this.jitsiApi.getParticipantsInfo?.() || [];
        this.log('Participants déjà présents : ' + existing.length);
        for (const p of existing) {
          this.addParticipant(p.participantId, p.displayName);
        }
      });

      this.jitsiApi.addListener('videoConferenceLeft', () => {
        this.log('videoConferenceLeft');
        this.leaveAttendance();
      });

      this.jitsiApi.addListener('participantRoleChanged', (event: any) => {
        this.log('participantRoleChanged : id=' + event?.id + ' role=' + event?.role);
      });

      // Liste des participants connectés, affichée côté professeur.
      this.jitsiApi.addListener('participantJoined', (event: any) => {
        this.log('participantJoined : ' + (event?.displayName || event?.id));
        this.addParticipant(event?.id, event?.displayName);
        this.knockingParticipants = this.knockingParticipants.filter(p => p.id !== event?.id);
        if (this.isTeacher && event?.displayName) {
          this.notifyJoin(event.displayName);
        }
      });
      this.jitsiApi.addListener('participantLeft', (event: any) => {
        this.log('participantLeft : ' + event?.id);
        this.connectedParticipants = this.connectedParticipants.filter(p => p.id !== event?.id);
      });

      // Le professeur partage son écran : on lui propose d'enregistrer le cours
      this.jitsiApi.addListener('screenSharingStatusChanged', (event: any) => {
        this.log('screenSharingStatusChanged : ' + event?.on);
        if (event?.on && this.isTeacher && !this.recording && !this.uploading) this.offerRecording();
      });

      this.jitsiApi.addListener('readyToClose', () => {
        this.log('readyToClose (la session a été quittée côté Jitsi)');
      });
    } catch (e: any) {
      const detail = e?.error?.message || e?.message || 'Erreur inconnue';
      this.log('ERREUR : ' + detail);
      this.uploadError = `Impossible de charger la visioconférence : ${detail}`;
    }
  }

  private log(message: string) {
    const time = new Date().toLocaleTimeString();
    this.debugLog.push(`[${time}] ${message}`);
  }

  private addParticipant(id: string, name: string) {
    if (id && !this.connectedParticipants.some(p => p.id === id)) {
      this.connectedParticipants.push({ id, name: name || 'Participant' });
    }
  }

  private notifyJoin(name: string) {
    this.joinNotifications.push(name);
    setTimeout(() => {
      this.joinNotifications = this.joinNotifications.filter(n => n !== name);
    }, 5000);
  }

  async startRecording() {
    this.uploadError = '';
    this.uploadSuccess = false;
    try {
      // 1. Capturer l'écran (+ audio système si l'utilisateur l'autorise)
      this.displayStream = await (navigator.mediaDevices as any).getDisplayMedia({
        // HD 720p, 15 images/s : texte de l'écran partagé net à la relecture
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15, max: 15 } },
        audio: true
      });

      // Un seul enregistrement à la fois par séance (professeur, admin, DR, DG…) : on réserve avant de commencer
      try {
        await firstValueFrom(this.http.post(`/api/teacher/virtual-classes/${this.vc!.id}/recording/start`, {},
          { context: new HttpContext().set(SILENT_ERRORS, true) }));
      } catch (e: any) {
        this.displayStream?.getTracks().forEach(t => t.stop());
        this.displayStream = null;
        await this.dialogs.alert({
          title: e?.status === 409 ? 'Le cours est déjà enregistré' : "Enregistrement impossible",
          message: e?.error?.message || "L'enregistrement n'a pas pu démarrer. Vérifiez votre connexion puis réessayez.",
          icon: e?.status === 409 ? 'bi-record-circle' : 'bi-exclamation-triangle', tone: e?.status === 409 ? 'info' : 'danger'
        });
        return;
      }

      // 2. Capturer le microphone de l'appareil connecté
      try {
        this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } catch {
        this.micStream = null;
      }

      // 3. Mixer audio système + micro via AudioContext
      this.recordingAudioCtx = new AudioContext();
      const dest = this.recordingAudioCtx.createMediaStreamDestination();

      const display = this.displayStream!;
      const audioCtx = this.recordingAudioCtx!;

      if (display.getAudioTracks().length > 0) {
        const sysSource = audioCtx.createMediaStreamSource(
          new MediaStream(display.getAudioTracks())
        );
        sysSource.connect(dest);
      }
      if (this.micStream && this.micStream.getAudioTracks().length > 0) {
        const micSource = audioCtx.createMediaStreamSource(this.micStream);
        micSource.connect(dest);
      }

      // Écran partagé (texte, diapositives) : le navigateur privilégie la netteté plutôt que la fluidité
      display.getVideoTracks().forEach(t => { try { (t as any).contentHint = 'detail'; } catch { /* non supporté */ } });

      // 4. Stream final : vidéo écran + audio mixé
      const combined = new MediaStream([
        ...display.getVideoTracks(),
        ...dest.stream.getAudioTracks()
      ]);

      // 5. Lancer l'enregistrement
      this.recordedChunks = [];
      this.chunkSeq = 0;
      this.chunkQueue = [];
      this.chunkFailed = false;
      this.lastSavedAt = null;
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
        ? 'video/webm;codecs=vp9,opus'
        : 'video/webm';
      // ~1 Mbit/s au total (≈ 450 Mo par heure) : image claire ; le serveur en tire aussi une version légère
      this.mediaRecorder = new MediaRecorder(combined, {
        mimeType,
        videoBitsPerSecond: 900_000,
        audioBitsPerSecond: 64_000
      });
      this.mediaRecorder.ondataavailable = (e: BlobEvent) => {
        if (e.data.size === 0) return;
        this.recordedChunks.push(e.data);
        this.chunkQueue.push({ seq: this.chunkSeq++, blob: e.data });
        this.sendChunks();
      };
      this.mediaRecorder.onstop = () => this.finishRecording();
      // Partage d'écran arrêté depuis le navigateur : l'enregistrement s'arrête et est sauvegardé
      display.getVideoTracks()[0].onended = () => {
        if (!this.recording) return;
        this.stopRecording(saved => this.announceSaved(saved,
          "Le partage d'écran a été arrêté, donc l'enregistrement aussi. "));
      };
      // Un morceau toutes les 20 s : le cours est sauvegardé au fur et à mesure
      this.mediaRecorder.start(VirtualClassRoomComponent.CHUNK_MS);
      this.recording = true;
    } catch (e) {
      this.uploadError = "Impossible de démarrer l'enregistrement (autorisation refusée).";
    }
  }

  /** Appelé une fois l'enregistrement arrêté ET sauvegardé (true) ou non (false). */
  private stopCallback: ((saved: boolean) => void) | null = null;

  /** Partage d'écran démarré dans la visio : proposer d'enregistrer le cours (une fois par partage). */
  private offeringRecording = false;
  private async offerRecording() {
    if (this.offeringRecording) return;
    this.offeringRecording = true;
    const ok = await this.dialogs.confirm({
      title: 'Enregistrer le cours ?',
      message: "Vous partagez votre écran. Voulez-vous lancer l'enregistrement du cours maintenant ?\n\n"
        + "Le navigateur va vous demander quoi enregistrer : choisissez le même écran (ou la même fenêtre) "
        + "et cochez « Partager l'audio » s'il est proposé.",
      icon: 'bi-record-circle', tone: 'danger', confirmText: "Oui, lancer l'enregistrement", cancelText: 'Non, pas maintenant'
    });
    this.offeringRecording = false;
    if (ok && !this.recording) this.startRecording();
  }

  /** Quelque chose a été enregistré dans cette séance (en cours, sauvegardé, ou déjà sur le serveur). */
  get hasSomethingRecorded(): boolean {
    return this.recording || !!this.lastSavedAt || this.uploadSuccess || !!this.vc?.recordingUrl;
  }

  discarding = false;

  /** Supprime ce qui a été enregistré, sans quitter la salle ni arrêter le cours. */
  async discardRecording() {
    if (!this.vc || this.discarding) return;
    const ok = await this.dialogs.confirm({
      title: "Supprimer l'enregistrement ?",
      message: "Tout ce qui a été enregistré dans cette séance sera supprimé définitivement.\n\n"
        + "Le cours continue en direct pour tout le monde. Vous pourrez ensuite démarrer un nouvel enregistrement.",
      icon: 'bi-trash3', tone: 'danger', confirmText: "Oui, supprimer l'enregistrement", cancelText: 'Non, garder'
    });
    if (!ok) return;
    this.discarding = true;
    // Arrêt sans sauvegarde : plus aucun morceau n'est envoyé
    if (this.mediaRecorder) {
      this.mediaRecorder.ondataavailable = null;
      this.mediaRecorder.onstop = null;
      if (this.mediaRecorder.state !== 'inactive') this.mediaRecorder.stop();
    }
    this.displayStream?.getTracks().forEach(t => t.stop());
    this.micStream?.getTracks().forEach(t => t.stop());
    this.micStream = null;
    this.recordingAudioCtx?.close();
    this.recordingAudioCtx = null;
    this.recording = false;
    this.chunkQueue = [];
    await this.waitForChunks(30000);   // le morceau en cours d'envoi finit avant la suppression
    try {
      await firstValueFrom(this.http.delete(`/api/teacher/virtual-classes/${this.vc.id}/recording`));
      this.recordedChunks = [];
      this.lastSavedAt = null;
      this.uploadSuccess = false;
      this.uploadError = '';
      this.vc.recordingUrl = null;
      this.dialogs.success('Enregistrement supprimé',
        "L'enregistrement a été supprimé. Le cours continue en direct : vous pouvez démarrer un nouvel enregistrement quand vous voulez.");
    } catch { /* la raison est affichée en popup par l'intercepteur d'erreurs */ }
    this.discarding = false;
  }

  /** Bouton « Arrêter l'enregistrement » : confirmation, puis message indiquant où trouver le cours. */
  async confirmStopRecording() {
    const ok = await this.dialogs.confirm({
      title: "Arrêter l'enregistrement ?",
      message: "Êtes-vous sûr de vouloir arrêter l'enregistrement ? Tout ce qui a été enregistré jusqu'ici sera sauvegardé. "
        + "Le cours continue en direct : seul l'enregistrement s'arrête.",
      icon: 'bi-stop-circle',
      tone: 'danger',
      confirmText: "Oui, arrêter l'enregistrement",
      cancelText: 'Non, continuer'
    });
    if (!ok || !this.recording) return;
    this.stopRecording(saved => this.announceSaved(saved));
  }

  /** Dit clairement au professeur ou à l'administrateur si le cours est enregistré, et où le retrouver. */
  private announceSaved(saved: boolean, intro = ''): Promise<void> {
    if (saved) {
      return this.dialogs.alert({
        title: 'Cours enregistré',
        message: intro + "L'enregistrement du cours est sauvegardé dans la plateforme. "
          + "Vous le retrouverez dans l'onglet « Passées » des Classes virtuelles, dès que la séance sera terminée.",
        icon: 'bi-check-circle',
        tone: 'success'
      });
    }
    return this.dialogs.alert({
      title: "Enregistrement non sauvegardé",
      message: intro + (this.uploadError || "L'enregistrement n'a pas pu être envoyé à la plateforme.")
        + " Ne fermez pas cette page et vérifiez votre connexion internet.",
      icon: 'bi-exclamation-triangle',
      tone: 'danger'
    });
  }

  stopRecording(onStopped?: (saved: boolean) => void) {
    this.stopCallback = onStopped || null;
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      // stop() est asynchrone : onstop (qui termine la sauvegarde) arrive après le dernier morceau
      this.mediaRecorder.stop();
    } else {
      this.finishRecording();
    }
    this.displayStream?.getTracks().forEach(t => t.stop());
    this.micStream?.getTracks().forEach(t => t.stop());
    this.micStream = null;
    this.recordingAudioCtx?.close();
    this.recordingAudioCtx = null;
    this.recording = false;
  }

  /** Envoie les morceaux en attente, un à la fois et dans l'ordre ; réessaie après une coupure réseau. */
  private sendChunks() {
    if (this.chunkSending || !this.vc) return;
    const next = this.chunkQueue[0];
    if (!next || this.chunkFailed) {
      this.chunkWaiters.splice(0).forEach(done => done());
      return;
    }
    this.chunkSending = true;
    const body = new FormData();
    body.append('file', next.blob, `session-${this.vc.id}-${next.seq}.webm`);
    this.http.post(`/api/teacher/virtual-classes/${this.vc.id}/recording/chunk`, body, {
      params: { seq: next.seq },
      context: new HttpContext().set(SILENT_ERRORS, true)
    }).subscribe({
      next: () => {
        this.chunkQueue.shift();
        this.chunkSending = false;
        this.lastSavedAt = new Date();
        this.sendChunks();
      },
      error: (e) => {
        this.chunkSending = false;
        if (e?.status === 409 || e?.status === 403 || e?.status === 404) {
          // Le serveur a perdu le fil : la vidéo complète sera envoyée à la fin
          this.chunkFailed = true;
          this.chunkQueue = [];
          this.chunkWaiters.splice(0).forEach(done => done());
        } else {
          setTimeout(() => this.sendChunks(), 5000);
        }
      }
    });
  }

  /** Attend que tous les morceaux soient envoyés ; false si ce n'est pas fait à temps. */
  private waitForChunks(timeoutMs: number): Promise<boolean> {
    if (this.chunkQueue.length === 0 && !this.chunkSending) return Promise.resolve(true);
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.chunkWaiters.push(() => { clearTimeout(timer); resolve(this.chunkQueue.length === 0); });
    });
  }

  /** Fin de l'enregistrement : derniers morceaux, miniature ; la vidéo complète en secours si besoin. */
  private async finishRecording() {
    const done = (saved: boolean) => {
      this.uploading = false;
      this.uploadSuccess = saved;
      const cb = this.stopCallback;
      this.stopCallback = null;
      cb?.(saved);
    };
    if (!this.vc || this.recordedChunks.length === 0) {
      done(false);
      return;
    }
    this.uploading = true;
    this.uploadError = '';
    const blob = new Blob(this.recordedChunks, { type: 'video/webm' });
    const thumbnail = await this.extractThumbnailFromBlob(blob);
    const allSent = !this.chunkFailed && await this.waitForChunks(60000);
    try {
      if (allSent && !this.chunkFailed) {
        await firstValueFrom(this.http.post(`/api/teacher/virtual-classes/${this.vc.id}/recording/finish`,
          { thumbnail }, { context: new HttpContext().set(SILENT_ERRORS, true) }));
      } else {
        // Secours : la vidéo complète, d'un seul envoi (jusqu'à 600 Mo)
        if (blob.size > 600 * 1024 * 1024) {
          this.uploadError = `Enregistrement trop volumineux (${Math.round(blob.size / (1024 * 1024))} Mo, maximum 600 Mo).`;
          done(false);
          return;
        }
        this.chunkQueue = [];
        const body = new FormData();
        body.append('file', blob, `session-${this.vc.id}.webm`);
        if (thumbnail) body.append('thumbnail', thumbnail);
        await firstValueFrom(this.http.post(`/api/teacher/virtual-classes/${this.vc.id}/recording`, body,
          { context: new HttpContext().set(SILENT_ERRORS, true) }));
      }
      done(true);
    } catch {
      this.uploadError = "Erreur lors de l'envoi de l'enregistrement vers la plateforme.";
      done(false);
    }
  }

  private extractThumbnailFromBlob(blob: Blob): Promise<string> {
    return new Promise(resolve => {
      const video = document.createElement('video');
      const url = URL.createObjectURL(blob);
      video.src = url;
      video.muted = true;
      video.currentTime = 1;
      video.onloadeddata = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 180;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(video, 0, 0, 320, 180);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
          resolve(dataUrl.split(',')[1]);
        } else {
          resolve('');
        }
        URL.revokeObjectURL(url);
      };
      video.onerror = () => { URL.revokeObjectURL(url); resolve(''); };
    });
  }

  /** Fin prévue de la séance ; chrono 2 minutes avant, puis arrêt et sauvegarde automatiques (côté animateur). */
  private startEndTimer() {
    if (!this.vc || !this.isTeacher || !this.vc.durationMinutes) return;
    const durationMs = this.vc.durationMinutes * 60 * 1000;
    const scheduledEnd = new Date(this.vc.scheduledAt).getTime() + durationMs;
    // Séance démarrée après son heure de fin prévue (retard, séance rouverte) : la durée compte depuis l'entrée
    const key = `vc-room-entered-${this.vc.id}`;
    let entered = Date.now();
    try {
      const stored = Number(sessionStorage.getItem(key));
      if (stored > 0) entered = stored; else sessionStorage.setItem(key, String(entered));
    } catch { /* stockage indisponible : l'entrée compte depuis maintenant */ }
    this.endAt = scheduledEnd > entered ? scheduledEnd : entered + durationMs;
    this.endTicker = setInterval(() => this.tickEnd(), 1000);
    this.tickEnd();
  }

  private tickEnd() {
    if (this.autoEnded || !this.vc) return;
    const left = this.endAt - Date.now();
    this.endCountdown = left <= VirtualClassRoomComponent.WARN_BEFORE_END_MS ? Math.ceil(Math.max(0, left) / 1000) : null;
    if (left > 0 || this.ending) return;
    this.autoEnded = true;
    this.endCountdown = null;
    if (this.endTicker) clearInterval(this.endTicker);
    this.endSession(true);
  }

  /** « Terminer la session » : confirmation, sauvegarde de l'enregistrement, puis l'onglet « Passées ». */
  async endSession(auto = false) {
    if (!this.vc || this.ending) return;
    const ok = auto || await this.dialogs.confirm({
      title: 'Terminer la séance ?',
      message: this.recording
        ? "L'enregistrement en cours sera arrêté et sauvegardé, puis la séance sera fermée : "
          + "le lien ne permettra plus d'entrer. Le cours enregistré sera dans l'onglet « Passées »."
        : "La séance sera fermée pour tout le monde : le lien ne permettra plus d'entrer.",
      icon: 'bi-box-arrow-right',
      tone: 'warning',
      confirmText: 'Oui, terminer la séance',
      cancelText: 'Non, continuer le cours'
    });
    if (!ok) return;
    this.ending = true;

    let saved = this.uploadSuccess;
    if (this.recording) {
      // On attend que l'enregistrement soit arrêté ET sauvegardé avant de quitter la page
      saved = await new Promise<boolean>(resolve => this.stopRecording(resolve));
      if (!saved) {
        this.ending = false;
        await this.announceSaved(false);
        return;
      }
    }

    if (this.isTeacher && this.vc.status !== 'COMPLETED') {
      try {
        await firstValueFrom(this.http.put(`/api/teacher/virtual-classes/${this.vc.id}/status`, {}, { params: { status: 'COMPLETED' } }));
      } catch { /* la page des classes affichera l'état réel */ }
    }
    this.ending = false;
    try { sessionStorage.removeItem(`vc-room-entered-${this.vc.id}`); } catch { /* sans effet */ }
    const reason = auto ? `La durée prévue (${this.vc.durationMinutes} min) est atteinte. ` : '';
    await this.dialogs.alert(saved
      ? {
          title: auto ? 'Durée atteinte — cours enregistré' : 'Séance terminée — cours enregistré',
          message: reason + "La séance est terminée et son enregistrement est sauvegardé. "
            + "Vous allez le trouver dans l'onglet « Passées » des Classes virtuelles.",
          icon: 'bi-check-circle',
          tone: 'success',
          confirmText: "Voir l'onglet Passées"
        }
      : {
          title: auto ? 'Durée atteinte — séance terminée' : 'Séance terminée',
          message: reason + "La séance est terminée. Elle n'a pas été enregistrée ; vous la retrouverez dans l'onglet « Passées ».",
          icon: 'bi-info-circle',
          tone: 'info',
          confirmText: "Voir l'onglet Passées"
        });
    this.router.navigate(['/virtual-class'], { queryParams: { tab: 'past' } });
  }
}
