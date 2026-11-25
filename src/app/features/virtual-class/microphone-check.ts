import { DialogService } from '../../core/services/dialog.service';

/** Navigateur intégré à une application (WhatsApp, Facebook…), où le micro est souvent bloqué. */
export function inAppBrowser(): string | null {
  const ua = navigator.userAgent || '';
  if (/WhatsApp/i.test(ua)) return 'WhatsApp';
  if (/FBAN|FBAV|FB_IAB|FBIOS/i.test(ua)) return 'Facebook';
  if (/Instagram/i.test(ua)) return 'Instagram';
  if (/Telegram/i.test(ua)) return 'Telegram';
  if (/TikTok|musical_ly|BytedanceWebview/i.test(ua)) return 'TikTok';
  if (/LinkedInApp/i.test(ua)) return 'LinkedIn';
  if (/Snapchat/i.test(ua)) return 'Snapchat';
  if (/; wv\)/.test(ua)) return 'une application';
  return null;
}

type MicProblem = 'blocked' | 'missing' | 'busy' | 'other';

const MIC_ADVICE: Record<MicProblem, string> = {
  blocked: 'Le micro est bloqué pour ce site.\n\n'
    + '• Ordinateur : cliquez sur le cadenas à gauche de l\'adresse du site, mettez « Micro » sur « Autoriser », puis rechargez la page.\n'
    + '• Android (Chrome) : touchez le cadenas à gauche de l\'adresse, puis « Autorisations » → « Micro » → « Autoriser ».\n'
    + '• iPhone : Réglages → Safari → Micro → « Autoriser », puis rechargez la page.',
  missing: 'Aucun micro n\'a été trouvé sur cet appareil. Branchez des écouteurs ou un casque avec micro, '
    + 'ou rejoignez le cours depuis votre téléphone.',
  busy: 'Le micro est déjà utilisé par une autre application (appel WhatsApp ou téléphonique, Zoom, Teams, Meet…). '
    + 'Raccrochez ou fermez cette application, puis rechargez la page.',
  other: 'Le micro n\'a pas pu être activé. Rechargez la page ; si le problème continue, essayez avec Google Chrome.'
};

/** Erreur du navigateur (getUserMedia) → type de problème. */
function problemFromBrowser(name: string): MicProblem {
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'blocked';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return 'missing';
  if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') return 'busy';
  return 'other';
}

/** Erreur signalée par la visioconférence (événement « micError » : gum.permission_denied, gum.not_found…). */
function problemFromJitsi(type: string): MicProblem {
  const t = (type || '').toLowerCase();
  if (t.includes('permission')) return 'blocked';
  if (t.includes('not_found') || t.includes('constraint')) return 'missing';
  if (t.includes('no_data') || t.includes('timeout') || t.includes('general')) return 'busy';
  return 'other';
}

/**
 * Vérifie le micro avant d'entrer dans la visioconférence et explique clairement quoi faire s'il ne marche pas.
 * N'empêche jamais d'entrer : sans micro, on peut toujours écouter le cours.
 * @return true si le micro est utilisable
 */
export async function checkMicrophone(dialogs: DialogService): Promise<boolean> {
  const app = inAppBrowser();
  if (app) {
    await dialogs.alert({
      title: 'Ouvrez le lien dans votre navigateur',
      message: `Vous avez ouvert ce lien dans ${app} : le micro et la caméra y fonctionnent souvent mal.\n\n`
        + '• Android : touchez « ⋮ » en haut à droite, puis « Ouvrir dans Chrome ».\n'
        + '• iPhone : touchez le bouton de partage ou « … », puis « Ouvrir dans Safari ».\n\n'
        + 'Vous pouvez aussi copier le lien et le coller dans Chrome ou Safari.',
      icon: 'bi-browser-chrome', tone: 'warning', confirmText: "J'ai compris"
    });
  }

  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    await dialogs.alert({
      title: 'Micro indisponible dans ce navigateur',
      message: 'Ce navigateur ne permet pas d\'utiliser le micro. Ouvrez le lien dans Google Chrome, Microsoft Edge ou Safari à jour.\n\n'
        + 'Vous pouvez entrer quand même pour écouter le cours.',
      icon: 'bi-mic-mute', tone: 'warning', confirmText: 'Entrer quand même'
    });
    return false;
  }

  try {
    // Sans réponse du navigateur au bout de 20 s (fenêtre d'autorisation ignorée), on laisse entrer quand même
    const stream = await withTimeout(navigator.mediaDevices.getUserMedia({ audio: true }), 20_000);
    if (!stream) return true;
    stream.getTracks().forEach(t => t.stop());
    return true;
  } catch (e: any) {
    await showMicProblem(dialogs, problemFromBrowser(e?.name || ''), true);
    return false;
  }
}

/** Micro tombé en panne dans la salle (signalé par la visioconférence) : mêmes explications. */
export function explainMicError(dialogs: DialogService, jitsiType: string): Promise<unknown> {
  return showMicProblem(dialogs, problemFromJitsi(jitsiType), false);
}

function showMicProblem(dialogs: DialogService, problem: MicProblem, beforeJoining: boolean): Promise<unknown> {
  return dialogs.alert({
    title: 'Votre micro ne fonctionne pas',
    message: MIC_ADVICE[problem] + (beforeJoining
      ? '\n\nVous pouvez entrer quand même pour écouter le cours.'
      : '\n\nVous continuez à voir et entendre le cours ; les autres ne vous entendent pas tant que le micro n\'est pas réglé.'),
    icon: 'bi-mic-mute', tone: 'warning', confirmText: beforeJoining ? 'Entrer quand même' : "J'ai compris"
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}

declare const JitsiMeetExternalAPI: any;

/**
 * Charge la visioconférence, avec 3 essais : sur une connexion mobile faible, le premier
 * téléchargement échoue ou n'aboutit jamais, et l'étudiant restait bloqué devant une page vide.
 */
export async function loadJitsiScript(domain: string): Promise<void> {
  if (typeof JitsiMeetExternalAPI !== 'undefined') return;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await loadScriptOnce(`https://${domain}/external_api.js`, 20_000);
      return;
    } catch (e) {
      lastError = e;
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw lastError ?? new Error('Visioconférence indisponible');
}

function loadScriptOnce(src: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    document.querySelectorAll(`script[src="${src}"]`).forEach(s => s.remove());
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    const timer = setTimeout(() => { script.remove(); reject(new Error('Délai dépassé')); }, timeoutMs);
    script.onload = () => {
      clearTimeout(timer);
      typeof JitsiMeetExternalAPI !== 'undefined' ? resolve() : reject(new Error('Script incomplet'));
    };
    script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('Visioconférence indisponible')); };
    document.body.appendChild(script);
  });
}

/**
 * Garde l'écran du téléphone allumé pendant le cours : en veille, le téléphone coupe le micro et la connexion.
 * Repris automatiquement quand l'étudiant revient sur la page.
 */
export class ScreenWakeLock {
  private lock: any = null;
  private active = false;
  private readonly onVisible = () => { if (this.active && document.visibilityState === 'visible') this.acquire(); };

  start() {
    if (this.active) return;
    this.active = true;
    document.addEventListener('visibilitychange', this.onVisible);
    this.acquire();
  }

  stop() {
    this.active = false;
    document.removeEventListener('visibilitychange', this.onVisible);
    try { this.lock?.release(); } catch { /* déjà libéré */ }
    this.lock = null;
  }

  private async acquire() {
    try {
      const wl = (navigator as any).wakeLock;
      if (wl && !this.lock) {
        this.lock = await wl.request('screen');
        this.lock.addEventListener?.('release', () => { this.lock = null; });
      }
    } catch { /* non pris en charge ou refusé : les conseils affichés suffisent */ }
  }
}

/**
 * Réglages de la visio communs à tous : chacun peut entrer et parler, quels que soient l'appareil et la connexion.
 */
export const RESILIENT_JITSI_CONFIG = {
  prejoinPageEnabled: false,
  prejoinConfig: { enabled: false },
  requireDisplayName: false,
  lobby: { enabled: false },
  hideLobbyButton: true,
  enableLobbyChat: false,
  disableDeepLinking: true,
  // Personne n'entre micro coupé d'office (sinon, passé quelques participants, les suivants entrent muets sans le savoir)
  startAudioMuted: 999,
  startWithAudioMuted: false,
  // Préviennent l'étudiant si son micro ne capte rien ou capte du bruit
  enableNoAudioDetection: true,
  enableNoisyMicDetection: true,
  // Les vidéos des autres baissent en qualité avant que le son ne coupe sur une connexion faible
  enableLayerSuspension: true,
  desktopSharingFrameRate: { min: 5, max: 15 }
};
