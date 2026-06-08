import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import http from 'http';

// ── API Configuration ─────────────────────────────────────────────────────────
const API_PORT = process.env.API_PORT || 3000;
const API_KEY = process.env.API_KEY || '5c6efa298f1b1c0b21ebbe3470d787836d579388158100707edd553b94ca0f90';

// ── Suppress Baileys Signal-protocol noise ───────────────────────────────────
// Baileys' libsignal layer calls console.log() directly (not through pino),
// so the noopLogger below doesn't catch it. We patch console.log once here
// to drop those specific noisy lines before they reach the terminal.
const _origLog = console.log.bind(console);
console.log = (...args) => {
    const first = typeof args[0] === 'string' ? args[0] : '';
    if (
        first.startsWith('Closing open session') ||
        first.startsWith('Closing session:')
    ) return;
    _origLog(...args);
};

// Fully silent logger — suppresses ALL Baileys internal pino output,
// including spurious RC-version ack errors. Our own console.error()
// calls in try/catch blocks are unaffected by this logger.
const noopLogger = {
    level: 'silent',
    trace: () => { },
    debug: () => { },
    info: () => { },
    warn: () => { },
    error: () => { },
    fatal: () => { },
    child: () => noopLogger,
};

// ── HTTP API Server ───────────────────────────────────────────────────────────
// Shared socket reference — updated on every reconnect
let currentSock = null;

const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');

    // Only accept POST /send-message
    if (req.method !== 'POST' || req.url !== '/send-message') {
        res.writeHead(404);
        return res.end(JSON.stringify({ success: false, error: 'Not found' }));
    }

    // Validate API key
    const key = req.headers['x-api-key'];
    if (!key || key !== API_KEY) {
        res.writeHead(401);
        return res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
    }

    if (!currentSock) {
        res.writeHead(503);
        return res.end(JSON.stringify({ success: false, error: 'WhatsApp not connected yet' }));
    }

    // Parse request body
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
        try {
            const { to, message } = JSON.parse(body);

            if (!to || !message) {
                res.writeHead(400);
                return res.end(JSON.stringify({ success: false, error: '"to" and "message" are required' }));
            }

            // Normalise number → JID  (add @s.whatsapp.net if missing)
            const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;

            await currentSock.sendMessage(jid, { text: message });
            console.log(`[API] Message sent to ${jid}`);

            res.writeHead(200);
            res.end(JSON.stringify({ success: true }));
        } catch (err) {
            console.error('[API] Error:', err.message);
            res.writeHead(500);
            res.end(JSON.stringify({ success: false, error: err.message }));
        }
    });
});

function listenOnPort(port) {
    server.listen(port, () => {
        console.log(`[API] HTTP server listening on port ${port}`);
        console.log(`[API] API key: ${API_KEY}`);
    });
}

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        const currentPort = server.address()?.port ?? API_PORT;
        const nextPort = Number(currentPort) + 1;
        console.warn(`[API] Port ${currentPort} in use, trying ${nextPort}...`);
        server.close();
        listenOnPort(nextPort);
    } else {
        console.error('[API] Server error:', err.message);
    }
});

listenOnPort(API_PORT);

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth');

    // Fetch the latest supported WA Web version
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[INFO] Using WA Web v${version.join('.')}, isLatest: ${isLatest}`);

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false, // We render the QR manually via qrcode-terminal
        logger: noopLogger,
    });

    // ── Persist credentials on every update ─────────────────────────────────
    sock.ev.on('creds.update', saveCreds);

    // ── Connection lifecycle ─────────────────────────────────────────────────
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // Show QR code in terminal when WhatsApp requests it
        if (qr) {
            console.log('\n[INFO] Scan the QR code below with your WhatsApp app:\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'connecting') {
            console.log('[INFO] Connecting to WhatsApp...');
        } else if (connection === 'open') {
            console.log('[INFO] Connection open — bot is ready.');
            currentSock = sock;
        } else if (connection === 'close') {
            currentSock = null; // Mark as disconnected so API returns 503
            const boom = lastDisconnect?.error instanceof Boom
                ? lastDisconnect.error
                : null;
            const statusCode = boom?.output?.statusCode;
            const reason = Object.entries(DisconnectReason).find(
                ([, v]) => v === statusCode
            )?.[0] ?? 'unknown';

            console.log(`[INFO] Connection closed. Reason: ${reason} (${statusCode})`);

            // Do NOT reconnect if logged out or if another session replaced this one
            const noReconnect =
                statusCode === DisconnectReason.loggedOut ||
                statusCode === DisconnectReason.connectionReplaced;

            if (!noReconnect) {
                console.log('[INFO] Reconnecting...');
                startBot().catch((err) => {
                    console.error('[ERROR] Failed to reconnect:', err);
                });
            } else if (statusCode === DisconnectReason.connectionReplaced) {
                console.log('[INFO] Another WhatsApp session replaced this one. Close WhatsApp Web in your browser and restart the bot.');
            } else {
                console.log('[INFO] Logged out. Delete the ./auth directory and restart to re-authenticate.');
            }
        }
    });

    // ── Incoming messages ────────────────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        // 'notify' = real new messages pushed to the device
        if (type !== 'notify') return;

        for (const msg of messages) {
            // Skip messages sent by this bot / our own account
            if (msg.key.fromMe) continue;

            // Extract plain text from common message types
            const text =
                msg.message?.conversation ??
                msg.message?.extendedTextMessage?.text ??
                null;

            if (!text) continue; // Ignore non-text messages (images, stickers, etc.)

            const sender = msg.key.remoteJid;
            console.log(`[MSG] ${sender}: ${text}`);

            try {
                await sock.sendMessage(
                    sender,
                    { text: `You said: ${text}` },
                    { quoted: msg },
                );
                console.log(`[REPLY] Replied to ${sender}`);
            } catch (err) {
                console.error(`[ERROR] Failed to send reply to ${sender}:`, err);
            }
        }
    });
}

// ── Entry point ──────────────────────────────────────────────────────────────
startBot().catch((err) => {
    console.error('[FATAL] Unhandled startup error:', err);
    process.exit(1);
});