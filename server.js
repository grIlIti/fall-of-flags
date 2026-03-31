const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.SECRET || 'fall-of-flags-secret-key-2024';

// Session store
const sessions = new Map();

function generateSessionCode() {
    const code = Math.floor(1000000000 + Math.random() * 8999999999).toString();
    return code;
}

function encryptCode(code) {
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(SECRET.padEnd(32, '0').slice(0, 32)), Buffer.alloc(16, 0));
    let encrypted = cipher.update(code);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return encrypted.toString('hex');
}

function decryptCode(encrypted) {
    try {
        const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(SECRET.padEnd(32, '0').slice(0, 32)), Buffer.alloc(16, 0));
        let decrypted = decipher.update(Buffer.from(encrypted, 'hex'));
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    } catch (e) {
        return null;
    }
}

function generatePIN() {
    // 10-digit PIN: user-friendly, easy to transmit via voice/text
    return Math.floor(1000000000 + Math.random() * 8999999999).toString();
}

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Fall of Flags WebRTC Signaling Server\nEndpoint: ws://localhost:3000\n');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('Client connected');
    let clientPin = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'create-session') {
                // Host creates session
                const pin = generatePin();
                const sessionId = `session-${pin}`;
                
                sessions.set(sessionId, {
                    pin: pin,
                    host: ws,
                    guest: null,
                    hostOffer: null,
                    guestAnswer: null,
                    createdAt: Date.now()
                });

                clientPin = pin;
                ws.send(JSON.stringify({ 
                    type: 'session-created', 
                    pin: pin,
                    encrypted: encryptCode(pin)
                }));
                console.log(`Session created: ${pin}`);
            }

            if (data.type === 'join-session') {
                // Guest joins with PIN
                const enteredPin = data.pin;
                const sessionId = `session-${enteredPin}`;

                if (!sessions.has(sessionId)) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
                    return;
                }

                const session = sessions.get(sessionId);
                if (session.guest) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Session full' }));
                    return;
                }

                session.guest = ws;
                clientPin = enteredPin;

                session.host.send(JSON.stringify({ 
                    type: 'guest-joined',
                    pin: enteredPin
                }));

                ws.send(JSON.stringify({ 
                    type: 'session-joined',
                    pin: enteredPin
                }));

                console.log(`Guest joined: ${enteredPin}`);
            }

            if (data.type === 'offer') {
                // Host sends offer
                const sessionId = `session-${clientPin}`;
                if (sessions.has(sessionId)) {
                    const session = sessions.get(sessionId);
                    session.hostOffer = data.offer;
                    if (session.guest) {
                        session.guest.send(JSON.stringify({ 
                            type: 'offer-received',
                            offer: data.offer
                        }));
                    }
                }
            }

            if (data.type === 'answer') {
                // Guest sends answer
                const sessionId = `session-${clientPin}`;
                if (sessions.has(sessionId)) {
                    const session = sessions.get(sessionId);
                    session.guestAnswer = data.answer;
                    if (session.host) {
                        session.host.send(JSON.stringify({ 
                            type: 'answer-received',
                            answer: data.answer
                        }));
                    }
                }
            }

            if (data.type === 'ice-candidate') {
                // Relay ICE candidates
                const sessionId = `session-${clientPin}`;
                if (sessions.has(sessionId)) {
                    const session = sessions.get(sessionId);
                    const targetWs = ws === session.host ? session.guest : session.host;
                    if (targetWs) {
                        targetWs.send(JSON.stringify({ 
                            type: 'ice-candidate',
                            candidate: data.candidate
                        }));
                    }
                }
            }

            if (data.type === 'game-state') {
                // Relay game state
                const sessionId = `session-${clientPin}`;
                if (sessions.has(sessionId)) {
                    const session = sessions.get(sessionId);
                    const targetWs = ws === session.host ? session.guest : session.host;
                    if (targetWs) {
                        targetWs.send(JSON.stringify({ 
                            type: 'game-state',
                            state: data.state
                        }));
                    }
                }
            }

            if (data.type === 'game-action') {
                // Relay game actions (moves)
                const sessionId = `session-${clientPin}`;
                if (sessions.has(sessionId)) {
                    const session = sessions.get(sessionId);
                    const targetWs = ws === session.host ? session.guest : session.host;
                    if (targetWs) {
                        targetWs.send(JSON.stringify({ 
                            type: 'game-action',
                            action: data.action
                        }));
                    }
                }
            }

        } catch (err) {
            console.error('Message error:', err);
        }
    });

    ws.on('close', () => {
        // Clean up session if client disconnects
        if (clientPin) {
            const sessionId = `session-${clientPin}`;
            const session = sessions.get(sessionId);
            if (session) {
                if (session.host === ws) session.host = null;
                if (session.guest === ws) session.guest = null;
                
                if (!session.host && !session.guest) {
                    sessions.delete(sessionId);
                    console.log(`Session deleted: ${clientPin}`);
                } else {
                    const remaining = session.host ? 'host' : 'guest';
                    const otherWs = remaining === 'host' ? session.host : session.guest;
                    if (otherWs) {
                        otherWs.send(JSON.stringify({ type: 'peer-disconnected' }));
                    }
                }
            }
        }
        console.log('Client disconnected');
    });

    ws.on('error', (err) => {
        console.error('WS error:', err);
    });
});

// Cleanup old sessions every 30 minutes
setInterval(() => {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000; // 30 minutes
    
    for (const [key, session] of sessions.entries()) {
        if (now - session.createdAt > maxAge) {
            if (session.host) session.host.close();
            if (session.guest) session.guest.close();
            sessions.delete(key);
            console.log(`Old session cleaned: ${key}`);
        }
    }
}, 30 * 60 * 1000);

server.listen(PORT, () => {
    console.log(`🎮 Fall of Flags WebRTC Signaling Server running on ws://localhost:${PORT}`);
    console.log(`Sessions active: ${sessions.size}`);
});
