import crypto from 'crypto';
import { getOrder, markOrderPaid } from '../_lib/orders.js';
import { sendThankYouEmail } from '../_lib/thankyou.js';
import { getSettings, getPrice } from '../_lib/settings.js';

// SingPay appelle cette URL (le "callback" configuré sur le portefeuille)
// une fois le paiement Mobile Money validé par le client sur son téléphone.
//
// Corps envoyé par SingPay :
//   { status: "Terminate", result: "Success", amount, reference,
//     transaction_id, client_msisdn, created_at, updated_at }
//
// La "reference" que nous recevons est l'identifiant de commande que nous
// avons envoyé au moment du paiement (orderId).
//
// Sécurité : SingPay ne signe pas ses notifications. On protège donc le
// webhook par un jeton secret placé dans l'URL de callback configurée sur
// le portefeuille (…/api/webhook/singpay?token=XXXX). Sans le bon jeton,
// impossible de faire passer une commande en « payée » depuis l'extérieur.
// Le montant reçu est aussi comparé au prix attendu, pour refuser un
// paiement partiel rejoué avec une vraie notification.

// Comparaison en temps constant, pour ne pas laisser deviner le jeton
// caractère par caractère en mesurant le temps de réponse.
function tokenMatches(expected, provided) {
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(provided || ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const settings = await getSettings();

  // Jeton attendu : variable d'environnement SINGPAY_WEBHOOK_TOKEN ou
  // réglage du tableau de bord (getSettings fait déjà l'arbitrage).
  const expectedToken = settings.singpayWebhookToken || '';
  if (expectedToken) {
    const provided = (req.query && req.query.token) || req.headers['x-webhook-token'];
    if (!tokenMatches(expectedToken, provided)) {
      return res.status(401).json({ error: 'bad_token' });
    }
  }

  const body = req.body || {};
  const { status, result, reference, transaction_id, amount } = body;

  if (!reference) {
    return res.status(400).json({ error: 'missing_reference' });
  }

  // On ne valide une commande que si SingPay indique un paiement réellement
  // abouti : traitement terminé ET résultat "Success".
  const success =
    String(status).toLowerCase() === 'terminate' &&
    String(result).toLowerCase() === 'success';

  try {
    const order = await getOrder(reference);
    if (!order) {
      // On renvoie 200 pour éviter que SingPay ne réessaie indéfiniment,
      // mais on signale que la commande est introuvable.
      return res.status(200).json({ ok: false, reason: 'order_not_found' });
    }

    if (!success) {
      return res.status(200).json({ ok: true, ignored: true, reason: 'not_successful' });
    }

    // Le montant encaissé doit couvrir le prix du livre. Un montant absent
    // ou insuffisant ne valide pas la commande : elle reste « en attente »
    // et se règle à la main depuis le tableau de bord si besoin.
    const expectedXAF = getPrice(settings).xaf;
    const receivedXAF = Number(amount);
    if (!Number.isFinite(receivedXAF) || receivedXAF < expectedXAF) {
      return res.status(200).json({ ok: false, reason: 'amount_mismatch' });
    }

    if (order.status !== 'paid') {
      await markOrderPaid(reference, {
        method: 'mobile_money',
        provider: 'singpay',
        providerTxId: transaction_id || null,
        amountXAF: receivedXAF,
      });

      // E-mail de remerciement (une seule fois).
      if (order.email && !order.thankYouSent) {
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const protocol = req.headers['x-forwarded-proto'] || 'https';
        try {
          await sendThankYouEmail({
            firstName: order.firstName || '',
            email: order.email,
            host,
            protocol,
          });
        } catch (e) {}
      }
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'server_error' });
  }
}
