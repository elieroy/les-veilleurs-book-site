// Endpoint unique du tableau de bord administrateur.
//
// Regroupe plusieurs actions pour rester sous la limite de fonctions
// serverless de Vercel. L'action est passée en paramètre : /api/admin?action=…
//
// Toutes les actions exigent le mot de passe administrateur, sauf "login"
// qui sert justement à le vérifier (avec limitation des tentatives).

import { store, storageReady, storageHealth } from './_lib/store.js';
import { saleState } from './launch.js';
import { listOrders, clearOrders, setOrderStatus, getOrder } from './_lib/orders.js';
import {
  getPublicSettingsStatus,
  saveSettings,
  getSettings,
  readinessFromSettings,
} from './_lib/settings.js';
import { isAdmin, checkRateLimit, clearRateLimit, passwordAudit } from './_lib/auth.js';
import { sendThankYouEmail } from './_lib/thankyou.js';

const DEFAULT_TOTAL = 200;

async function readStockTotal() {
  try {
    const raw = await store.get('stockTotal');
    // Attention : Number(null) vaut 0, pas NaN. Sans ce test explicite,
    // une base encore vide ferait croire à un stock de 0 exemplaire.
    if (raw === null || raw === undefined || raw === '') return DEFAULT_TOTAL;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TOTAL;
  } catch (e) {
    return DEFAULT_TOTAL;
  }
}

// Diagnostic complet : ce qui est prêt, ce qui manque.
// C'est ce qui permet de savoir en un coup d'œil si le site est
// réellement opérationnel, au lieu de le deviner.
async function buildDiagnostics() {
  const health = await storageHealth();
  const pwd = passwordAudit();

  let settings = {};
  let ready = {};
  let launchTs = null;
  let total = DEFAULT_TOTAL;
  let sold = 0;
  let orders = [];

  if (health.ready) {
    try {
      settings = await getSettings();
      ready = readinessFromSettings(settings);
      launchTs = await store.get('launchTime');
      total = await readStockTotal();
      orders = await listOrders(300);
      sold = orders.filter((o) => o && o.status === 'paid').length;
    } catch (e) {}
  }

  const checks = [
    {
      key: 'storage',
      label: 'Base de données',
      ok: health.ready,
      detail: health.ready
        ? 'Connectée et accessible.'
        : health.reason + " Sans elle, rien n'est enregistré : commandes, réglages et compte à rebours sont perdus.",
      critical: true,
    },
    {
      key: 'password',
      label: 'Mot de passe administrateur',
      ok: pwd.ok,
      detail: pwd.isKnownWeak
        ? "Le mot de passe livré d'origine est encore actif. Il est connu publiquement : changez-le avant toute vente réelle."
        : pwd.tooShort
          ? 'Mot de passe personnalisé mais trop court. Visez au moins 12 caractères.'
          : pwd.idealSetup
            ? "Mot de passe personnalisé, de longueur correcte, et défini en variable d'environnement. Configuration idéale."
            : "Mot de passe personnalisé et de longueur correcte. Pour aller plus loin, définissez ADMIN_PASSWORD dans les variables d'environnement Vercel : vous pourrez le changer sans redéployer le site.",
      critical: true,
    },
    {
      key: 'stripe',
      label: 'Stripe (carte bancaire, Apple Pay)',
      ok: Boolean(ready.card),
      detail: ready.card
        ? 'Clés enregistrées.'
        : 'Non configuré : les paiements par carte et Apple Pay sont indisponibles.',
      critical: false,
    },
    {
      key: 'stripeWebhook',
      label: 'Confirmation automatique Stripe',
      ok: Boolean(settings.stripeWebhookSecret),
      detail: settings.stripeWebhookSecret
        ? 'Secret de webhook enregistré : les paiements seront confirmés automatiquement.'
        : "Sans secret de webhook, un paiement par carte ne sera pas marqué « payé » automatiquement.",
      critical: false,
    },
    {
      key: 'paypal',
      label: 'PayPal',
      ok: Boolean(ready.paypal),
      detail: ready.paypal ? 'Identifiants enregistrés.' : 'Non configuré.',
      critical: false,
    },
    {
      key: 'singpay',
      label: 'SingPay (Airtel Money, Moov Money)',
      ok: Boolean(ready.airtel),
      detail: ready.airtel ? 'Identifiants enregistrés.' : 'Non configuré : le mobile money est indisponible.',
      critical: false,
    },
    {
      key: 'singpayWebhook',
      label: 'Sécurité du webhook SingPay',
      ok: !ready.airtel || Boolean(settings.singpayWebhookToken),
      detail: settings.singpayWebhookToken
        ? 'Jeton secret enregistré : seules les notifications portant ce jeton peuvent confirmer un paiement.'
        : ready.airtel
          ? "Sans jeton secret, n'importe qui connaissant l'URL du webhook pourrait marquer une commande comme payée. Renseignez le jeton dans les réglages SingPay ci-dessous et ajoutez-le à l'URL de callback."
          : 'Sans objet tant que SingPay n\'est pas configuré.',
      critical: false,
    },
    {
      key: 'email',
      label: 'E-mail de remerciement',
      ok: Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL),
      detail:
        process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL
          ? 'Envoi configuré.'
          : "Non configuré : aucun e-mail ne sera envoyé après paiement (variables RESEND_API_KEY et RESEND_FROM_EMAIL).",
      critical: false,
    },
    {
      key: 'launch',
      label: 'Fenêtre de vente',
      ok: true,
      detail: 'Pilotée depuis le bloc « Contrôle de la vente » ci-dessous.',
      critical: false,
    },
  ];

  const blocking = checks.filter((c) => c.critical && !c.ok);

  return {
    checks,
    liveReady: blocking.length === 0,
    blocking: blocking.map((c) => c.label),
    stock: { total, sold, remaining: Math.max(0, total - sold) },
    launchTs: launchTs ? Number(launchTs) : null,
  };
}

function toCsv(orders) {
  const head = ['Date', 'ID', 'Prénom', 'Nom', 'E-mail', 'Téléphone', 'Adresse', 'Moyen', 'Statut', 'Payé le'];
  const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const lines = [head.map(esc).join(',')];
  for (const o of orders) {
    lines.push(
      [
        o.createdAt || '',
        o.id || '',
        o.firstName || '',
        o.lastName || '',
        o.email || '',
        o.phone || '',
        o.address || '',
        o.method || '',
        o.status || '',
        o.paidAt || '',
      ]
        .map(esc)
        .join(',')
    );
  }
  return lines.join('\r\n');
}

export default async function handler(req, res) {
  const action = (req.query && req.query.action) || 'status';

  // --- Connexion : seule action ouverte, protégée par limitation de tentatives ---
  if (action === 'login') {
    const rl = await checkRateLimit(req);
    if (rl.blocked) {
      return res.status(429).json({
        ok: false,
        error: 'too_many_attempts',
        message: 'Trop de tentatives. Réessayez dans 15 minutes.',
      });
    }
    if (!isAdmin(req)) {
      return res.status(401).json({ ok: false, error: 'bad_password', remaining: rl.remaining });
    }
    await clearRateLimit(req);
    return res.status(200).json({ ok: true, storageReady });
  }

  // --- Toutes les autres actions exigent le mot de passe ---
  if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });

  try {
    switch (action) {
      case 'status':
        return res.status(200).json(await buildDiagnostics());

      case 'stats': {
        if (!storageReady) {
          return res.status(200).json({
            storageReady: false,
            visits: 0,
            transactions: [],
            orders: [],
            stock: { total: DEFAULT_TOTAL, sold: 0, remaining: DEFAULT_TOTAL },
          });
        }
        const visits = (await store.get('visits')) || 0;
        const rawTxns = (await store.lrange('transactions', 0, 199)) || [];
        const transactions = rawTxns.map((t) => (typeof t === 'string' ? JSON.parse(t) : t));
        const orders = await listOrders(300);
        const total = await readStockTotal();
        const sold = orders.filter((o) => o && o.status === 'paid').length;
        return res.status(200).json({
          storageReady: true,
          visits: Number(visits),
          transactions,
          orders,
          stock: { total, sold, remaining: Math.max(0, total - sold) },
        });
      }

      case 'settings-get':
        return res.status(200).json(await getPublicSettingsStatus());

      case 'settings-save':
        await saveSettings(req.body || {});
        return res.status(200).json(await getPublicSettingsStatus());

      case 'stock-set': {
        const t = parseInt((req.body || {}).total, 10);
        if (Number.isFinite(t) && t >= 0) await store.set('stockTotal', t);
        const total = await readStockTotal();
        const orders = await listOrders(300);
        const sold = orders.filter((o) => o && o.status === 'paid').length;
        return res.status(200).json({ total, sold, remaining: Math.max(0, total - sold) });
      }

      case 'order-status': {
        const { id, status, note, sendEmail } = req.body || {};
        if (!id || !['paid', 'pending', 'cancelled'].includes(status)) {
          return res.status(400).json({ error: 'bad_request' });
        }
        const before = await getOrder(id);
        const updated = await setOrderStatus(id, status, note || '');
        if (!updated) return res.status(404).json({ error: 'not_found' });

        // Marquage manuel « payé » : on envoie le message de remerciement,
        // exactement comme pour un paiement en ligne. Jamais deux fois
        // pour la même commande.
        let email = null;
        if (status === 'paid' && sendEmail !== false && updated.email && !(before && before.thankYouSent)) {
          const host = req.headers['x-forwarded-host'] || req.headers.host;
          const proto = req.headers['x-forwarded-proto'] || 'https';
          const r = await sendThankYouEmail({
            firstName: updated.firstName || '', email: updated.email, host, protocol: proto,
          });
          email = r;
          if (r && r.ok) await setOrderStatus(id, 'paid', note || '').then(() => store.set(
            `order:${id}`, JSON.stringify({ ...updated, thankYouSent: new Date().toISOString() })
          ));
        }
        return res.status(200).json({ ...updated, email });
      }

      case 'export': {
        const orders = await listOrders(1000);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="commandes-les-veilleurs.csv"');
        return res.status(200).send('\uFEFF' + toCsv(orders));
      }

      // --- Contrôle de la vente ---
      case 'sale-state':
        return res.status(200).json(await saleState());

      case 'sale-start': {
        // Lance (ou relance) la vente. Sans startTs, elle démarre maintenant.
        const b = req.body || {};
        const start = b.startTs ? Number(b.startTs) : Date.now();
        const hours = Number(b.durationHours);
        if (!Number.isFinite(start)) return res.status(400).json({ error: 'bad_start' });
        await store.set('launchTime', start);
        if (Number.isFinite(hours) && hours > 0) await store.set('launchDurationHours', hours);
        await store.del('saleClosed'); // une relance rouvre toujours la vente
        return res.status(200).json(await saleState());
      }

      case 'sale-close': {
        // Clôture immédiate, quel que soit le temps restant.
        await store.set('saleClosed', '1');
        return res.status(200).json(await saleState());
      }

      case 'sale-reopen': {
        // Annule une clôture manuelle (la fenêtre horaire reste la même).
        await store.del('saleClosed');
        return res.status(200).json(await saleState());
      }

      case 'sale-duration': {
        const hours = Number((req.body || {}).durationHours);
        if (!Number.isFinite(hours) || hours <= 0) return res.status(400).json({ error: 'bad_duration' });
        await store.set('launchDurationHours', hours);
        return res.status(200).json(await saleState());
      }

      case 'reset': {
        if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
        await store.set('visits', 0);
        await store.del('transactions');
        await clearOrders();
        return res.status(200).json({ ok: true });
      }

      default:
        return res.status(400).json({ error: 'unknown_action' });
    }
  } catch (e) {
    if (e && e.code === 'storage_not_configured') {
      return res.status(200).json({ error: 'storage_not_configured', storageReady: false });
    }
    return res.status(500).json({ error: 'server_error', message: e && e.message });
  }
}
