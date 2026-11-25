import { Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { HttpClient, HttpContext, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { SILENT_ERRORS } from '../../core/interceptors/error.interceptor';
import { DialogService } from '../../core/services/dialog.service';
import { checkMicrophone, explainMicError, loadJitsiScript, RESILIENT_JITSI_CONFIG, ScreenWakeLock } from './microphone-check';
import { AuthService } from '../../core/services/auth.service';

declare const JitsiMeetExternalAPI: any;

/** Reconnexions automatiques tentées après une coupure, avant de laisser le bouton à l'étudiant. */
const MAX_AUTO_RECONNECT = 3;

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

          <div *ngIf="error && !info.canJoin" class="alert alert-danger py-2 small">{{ error }}</div>
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
          <div *ngIf="offline" class="alert alert-danger small py-2 d-flex gap-2" role="alert">
            <i class="bi bi-wifi-off"></i>
            <span>Connexion internet perdue. Restez sur cette page : vous serez reconnecté(e) automatiquement dès le retour du réseau.</span>
          </div>
          <div *ngIf="!offline && reconnecting" class="alert alert-warning small py-2 d-flex gap-2" role="status">
            <span class="spinner-border spinner-border-sm"></span><span>Reconnexion à la séance…</span>
          </div>
          <div *ngIf="!joinedConference && !offline && !reconnecting" class="alert alert-info small py-2 d-flex flex-wrap align-items-center gap-2">
            <span class="flex-grow-1">Si une fenêtre « Rejoindre la réunion » s'affiche dans la vidéo, cliquez dessus pour entrer.</span>
            <button *ngIf="showReload" class="btn btn-sm btn-outline-primary" (click)="reconnect()">
              <i class="bi bi-arrow-clockwise me-1"></i>Ça ne charge pas ? Recharger la visio
            </button>
          </div>
          <div *ngIf="error && !joinedConference && !reconnecting" class="alert alert-danger small py-2">{{ error }}</div>
          <div *ngIf="joinedConference && micMuted" class="alert alert-secondary small py-2 d-flex gap-2" role="status">
            <i class="bi bi-mic-mute-fill text-danger"></i>
            <span>Votre micro est coupé. Pour parler, touchez le bouton <strong>micro</strong> en bas de la vidéo.</span>
          </div>
          <details class="small text-muted mb-2 mic-help">
            <summary><i class="bi bi-mic me-1"></i>On ne vous entend pas ?</summary>
            <ul class="mb-0 mt-1 ps-3">
              <li>Gardez l'écran allumé et cette page ouverte : en veille ou dans une autre application, le téléphone coupe le micro.</li>
              <li>Vérifiez le micro choisi : flèche <strong>^</strong> à côté du bouton micro, en bas de la vidéo.</li>
              <li>Après un appel WhatsApp ou téléphonique, rechargez la page.</li>
              <li>Connexion faible : coupez votre caméra, le son passera mieux.</li>
            </ul>
          </details>
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
  showReload = false;
  offline = !navigator.onLine;
  reconnecting = false;
  micMuted = false;
  private micChecked = false;
  private autoReconnects = 0;
  private micErrorShown = false;
  private joinTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly wakeLock = new ScreenWakeLock();
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

  @HostListener('window:offline')
  onOffline() { this.offline = true; }

  /** Réseau revenu : si la visio n'a pas tenu le coup, on y retourne sans que l'étudiant ait à cliquer. */
  @HostListener('window:online')
  onOnline() {
    this.offline = false;
    if (this.inRoom && !this.joinedConference) this.reconnect();
  }

  ngOnDestroy() {
    this.teardown();
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
      this.wakeLock.start();
      setTimeout(() => this.startConference(res), 0);
      this.heartbeat = setInterval(() => {
        if (!this.attendanceId) return;
        this.http.post(`${this.base}/attendance/${this.attendanceId}/heartbeat`, {},
          { ...this.silent, params: this.sessionParams }).subscribe({
          // Entrée depuis un autre appareil ou onglet : une seule connexion par personne, celle-ci quitte la salle
          error: e => { if (e?.status === 409) this.replaced(e.error?.message); }
        });
      }, 30_000);
      this.checkRollCall();
      this.rollCallPoll = setInterval(() => this.checkRollCall(), 15_000);
    } catch (e: any) {
      this.joining = false;
      this.reconnecting = false;
      this.error = e?.error?.message || (e?.status === 0 || !navigator.onLine
        ? 'Pas de connexion internet. Vérifiez votre réseau (données mobiles ou Wi-Fi) puis réessayez.'
        : 'Impossible de rejoindre la séance. Vérifiez votre connexion puis réessayez.');
      if (e?.status === 409) this.refreshInfo();
      // Échec pendant une reconnexion : on reste sur la salle avec le bouton pour réessayer
      if (this.inRoom) this.showReload = true;
    }
  }

  rejoin() { this.autoReconnects = 0; this.join(); }

  /** Visio bloquée ou coupée : on quitte proprement et on rentre avec un jeton neuf. */
  reconnect() {
    if (this.joining) return;
    this.teardown();
    this.reconnecting = true;
    this.join();
  }

  private replaced(message?: string) {
    this.attendanceId = null;
    this.leave();
    this.dialogs.alert({
      title: 'Connexion sur un autre appareil', icon: 'bi-phone', tone: 'warning', confirmText: "J'ai compris",
      message: message || 'Vous êtes entré(e) dans la séance depuis un autre appareil : une seule connexion par personne.'
    });
  }

  leave() {
    this.teardown();
    this.inRoom = false;
    this.left = true;
  }

  /** Ferme la visio et la présence (sans changer d'écran). */
  private teardown() {
    this.sendLeave();
    this.stopTimers();
    this.wakeLock.stop();
    if (this.joinTimeout) { clearTimeout(this.joinTimeout); this.joinTimeout = null; }
    try { this.jitsiApi?.dispose(); } catch { /* déjà fermé */ }
    this.jitsiApi = null;
    this.joinedConference = false;
    this.showReload = false;
    this.micMuted = false;
  }

  private async startConference(res: JoinResponse) {
    try {
      await loadJitsiScript(res.domain);
      if (!this.jitsiContainer || !this.inRoom) return;
      this.jitsiApi = new JitsiMeetExternalAPI(res.domain, {
        roomName: res.roomName,
        jwt: res.token,
        parentNode: this.jitsiContainer.nativeElement,
        width: '100%',
        height: '100%',
        userInfo: { displayName: res.displayName },
        configOverwrite: {
          ...RESILIENT_JITSI_CONFIG,
          // Caméra des participants en 360p : sur une petite connexion, la vidéo HD étouffait le son.
          // Le partage d'écran reste net (réglé à part).
          resolution: 360,
          constraints: { video: { height: { ideal: 360, max: 360, min: 180 } } }
        }
      });
      // Visio toujours pas ouverte après 15 s (connexion lente, fenêtre bloquée) : bouton pour recharger
      this.joinTimeout = setTimeout(() => { if (!this.joinedConference) this.showReload = true; }, 15_000);
      this.jitsiApi.addListener('videoConferenceJoined', () => {
        this.joinedConference = true;
        this.reconnecting = false;
        this.showReload = false;
        this.autoReconnects = 0;
        this.jitsiApi?.isAudioMuted?.().then((m: boolean) => this.micMuted = !!m).catch(() => {});
      });
      this.jitsiApi.addListener('audioMuteStatusChanged', (e: any) => { this.micMuted = !!e?.muted; });
      this.jitsiApi.addListener('micError', (e: any) => {
        if (this.micErrorShown) return;
        this.micErrorShown = true;
        explainMicError(this.dialogs, e?.type || '');
      });
      // Coupure grave de la visio (réseau, serveur) : reconnexion automatique, puis bouton
      this.jitsiApi.addListener('errorOccurred', (e: any) => {
        if (!e?.error?.isFatal || !this.inRoom) return;
        if (this.autoReconnects < MAX_AUTO_RECONNECT && navigator.onLine) {
          this.autoReconnects++;
          setTimeout(() => this.reconnect(), 2000);
        } else {
          this.joinedConference = false;
          this.showReload = true;
        }
      });
      this.jitsiApi.addListener('readyToClose', () => this.leave());
    } catch {
      // Visio introuvable même après plusieurs essais : on libère la présence et on laisse réessayer
      this.teardown();
      this.inRoom = false;
      this.reconnecting = false;
      this.error = 'La visioconférence n\'a pas pu se charger (connexion trop faible ou coupée). '
        + 'Vérifiez votre réseau puis cliquez sur « Rejoindre la classe ».';
    }
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
