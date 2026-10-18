'use strict';
const { EventEmitter } = require('events');
const { Server } = require('socket.io');

/** In-process bus. Services publish AFTER their transaction has committed to disk. */
function createBus() {
  const em = new EventEmitter();
  em.setMaxListeners(50);
  return {
    publish: (eventId, type, payload) => em.emit('message', { eventId, type, payload }),
    subscribe: (fn) => em.on('message', fn),
  };
}

/**
 * Socket.IO wiring.
 * - Each client joins the room `event:<id>` for exactly one event.
 * - Every change sends the domain event plus `display:refresh` with the full,
 *   versioned display state, so a client can always replace what it has.
 */
function attachRealtime(httpServer, { sessionMw, bus, services }) {
  const io = new Server(httpServer, { serveClient: true, pingInterval: 10000, pingTimeout: 8000 });
  io.engine.use(sessionMw);
  io.use((socket, next) => {
    const user = socket.request.session && socket.request.session.user;
    if (!user) return next(new Error('unauthenticated'));
    socket.data.user = user;
    next();
  });
  io.on('connection', (socket) => {
    // A throw inside a socket handler is not caught by Express, so guard it here:
    // a bad message must never take the server down in the middle of an event.
    socket.on('join', (eventId, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const id = Number(eventId);
        const ev = Number.isInteger(id) ? services.events.find(id) : null;
        if (!ev) return reply({ ok: false, error: 'Event not found' });
        for (const room of socket.rooms) if (room.startsWith('event:')) socket.leave(room);
        socket.join(`event:${id}`);
        reply({ ok: true, state: services.matches.displayState(id) });
      } catch (e) {
        console.error('[socket] join failed:', e.message);
        reply({ ok: false, error: 'Could not load the display state' });
      }
    });
  });
  bus.subscribe(({ eventId, type, payload }) => {
    if (!eventId) return;
    const room = io.to(`event:${eventId}`);
    let state;
    try { state = services.matches.displayState(eventId); } catch (_) { return; }
    if (type !== 'display:refresh') room.emit(type, { eventId, version: state.version, ...payload });
    room.emit('display:refresh', { eventId, version: state.version, forceReload: !!(payload && payload.forceReload), state });
  });
  return io;
}

module.exports = { createBus, attachRealtime };
