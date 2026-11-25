import { DialogService } from '../../core/services/dialog.service';

/** Navigateur intégré à une application (WhatsApp, Facebook…), où le micro est souvent bloqué. */
export function inAppBrowser(): string | null {
  const ua = navigator.userAgent || '';
  if (/WhatsApp/i.test(ua)) return 'WhatsApp';
  if (/FBAN|FBAV|FB_IAB|FBIOS/i.test(ua)) return 'Facebook';
  if (/Instagram/i.test(ua)) return 'Instagram';
  if (/; wv\)/.test(ua)) return 'une application';
  return null;
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

  if (!navigator.mediaDevices?.getUserMedia) {
    await dialogs.alert({
      title: 'Micro indisponible dans ce navigateur',
      message: 'Ce navigateur ne permet pas d\'utiliser le micro. Ouvrez le lien dans Google Chrome, Microsoft Edge ou Safari à jour.\n\n'
        + 'Vous pouvez entrer quand même pour écouter le cours.',
      icon: 'bi-mic-mute', tone: 'warning', confirmText: 'Entrer quand même'
    });
    return false;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
    return true;
  } catch (e: any) {
    const name = e?.name || '';
    let message: string;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      message = 'Le micro est bloqué pour ce site.\n\n'
        + '• Ordinateur : cliquez sur le cadenas à gauche de l\'adresse du site, mettez « Micro » sur « Autoriser », puis rechargez la page.\n'
        + '• Android (Chrome) : touchez le cadenas à gauche de l\'adresse, puis « Autorisations » → « Micro » → « Autoriser ».\n'
        + '• iPhone : Réglages → Safari → Micro → « Autoriser », puis rechargez la page.';
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      message = 'Aucun micro n\'a été trouvé sur cet appareil. Branchez des écouteurs ou un casque avec micro, '
        + 'ou rejoignez le cours depuis votre téléphone.';
    } else if (name === 'NotReadableError' || name === 'AbortError') {
      message = 'Le micro est déjà utilisé par une autre application (appel WhatsApp, Zoom, Teams, Meet…). '
        + 'Fermez cette application, puis rechargez la page.';
    } else {
      message = 'Le micro n\'a pas pu être activé. Rechargez la page ; si le problème continue, essayez avec Google Chrome.';
    }
    await dialogs.alert({
      title: 'Votre micro ne fonctionne pas',
      message: message + '\n\nVous pouvez entrer quand même pour écouter le cours.',
      icon: 'bi-mic-mute', tone: 'warning', confirmText: 'Entrer quand même'
    });
    return false;
  }
}
