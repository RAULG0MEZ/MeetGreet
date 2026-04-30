/* ── MeetGreet – app.js ────────────────────────────────────────────────────── */

const HOST_KEY = 'meetgreet_peer_id';

/* ── Helpers ─────────────────────────────────────────────────────────────── */
function uid(len = 8) {
  return Math.random().toString(36).slice(2, 2 + len);
}

function fmtTime(date = new Date()) {
  return date.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
}

function sanitize(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

/* ── Main app class ──────────────────────────────────────────────────────── */
class MeetGreet {
  constructor() {
    /* state */
    this.peer          = null;
    this.myId          = null;
    this.myName        = 'Yo';
    this.isHost        = false;
    this.localStream   = null;   // camera + mic stream
    this.screenStream  = null;   // screen-capture stream
    this.isMuted       = false;
    this.isCamOff      = false;
    this.isSharing     = false;
    this.chatOpen      = false;
    this.unread        = 0;
    this.connections   = new Map(); // peerId -> { call?, dataConn?, remoteName, isSharing }

    /* remote-control state */
    this.ctrlGranted    = false;  // I have been granted control
    this.ctrlTarget     = null;   // peerId I'm controlling
    this.ctrlRequester  = null;   // peerId that asked to control me

    this._init();
  }

  /* ── Boot ──────────────────────────────────────────────────────────────── */
  async _init() {
    this._bindUI();
    this._startClock();
    await this._requestMedia();
    this._addLocalTile();
    this._setupPeer();
  }

  /* ── Media ─────────────────────────────────────────────────────────────── */
  async _requestMedia() {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch {
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
        this.isCamOff = true;
      } catch {
        this.localStream = new MediaStream();
        this.isCamOff = true;
      }
    }
    this._syncMicBtn();
    this._syncCamBtn();
  }

  /* ── PeerJS setup ──────────────────────────────────────────────────────── */
  _setupPeer() {
    const params = new URLSearchParams(location.search);
    const joinId = params.get('join');

    if (joinId) {
      /* ── Guest mode ── */
      this.isHost = false;
      this.peer   = new Peer(undefined, { debug: 0 });
    } else {
      /* ── Host mode: fixed, persistent peer ID ── */
      this.isHost = true;
      let id = localStorage.getItem(HOST_KEY);
      if (!id) { id = 'mg-' + uid(10); localStorage.setItem(HOST_KEY, id); }
      this.peer = new Peer(id, { debug: 0 });
    }

    this.peer.on('open', id => {
      this.myId = id;
      this._setStatus(true);

      if (this.isHost) {
        /* Show shareable link right away */
        this._setInviteLink(id);
        document.getElementById('invite-modal').style.display = 'flex';
      } else {
        this._callPeer(joinId);
      }
    });

    /* Incoming call (someone calls us) */
    this.peer.on('call', call => {
      call.answer(this.localStream);
      this._handleCall(call);
    });

    /* Incoming data connection */
    this.peer.on('connection', conn => {
      this._handleDataConn(conn);
    });

    this.peer.on('error', err => {
      console.error('[peer]', err);
      if (err.type === 'peer-unavailable') {
        this._setStatus(false, 'El anfitrión no está disponible');
      }
    });

    this.peer.on('disconnected', () => this.peer.reconnect());
  }

  /* ── Connect to a peer ─────────────────────────────────────────────────── */
  _callPeer(peerId) {
    if (this.connections.has(peerId)) return;
    this.connections.set(peerId, { remoteName: 'Invitado' });

    const call = this.peer.call(peerId, this.localStream);
    if (!call) return;
    this._handleCall(call);

    const conn = this.peer.connect(peerId, { reliable: true, metadata: { name: this.myName } });
    this._handleDataConn(conn);
  }

  /* ── Handle a media call ───────────────────────────────────────────────── */
  _handleCall(call) {
    const pid = call.peer;

    call.on('stream', remoteStream => {
      const existing = this.connections.get(pid) || {};
      this.connections.set(pid, { ...existing, call, stream: remoteStream });
      this._addRemoteTile(pid, remoteStream, existing.remoteName || 'Invitado');
    });

    call.on('close', () => this._removePeer(pid));
    call.on('error', e => { console.error('[call]', e); this._removePeer(pid); });

    const existing = this.connections.get(pid) || {};
    this.connections.set(pid, { ...existing, call });
  }

  /* ── Handle a data connection ──────────────────────────────────────────── */
  _handleDataConn(conn) {
    const pid = conn.peer;

    conn.on('open', () => {
      const existing = this.connections.get(pid) || {};
      this.connections.set(pid, { ...existing, dataConn: conn });

      /* Host → tell new guest who else is in the room */
      if (this.isHost) {
        const others = [...this.connections.keys()].filter(k => k !== pid);
        if (others.length) conn.send({ type: 'peer-list', peers: others });
        /* Tell all others about this newcomer */
        this._broadcast({ type: 'new-peer', peerId: pid }, pid);
      }

      /* Send our display name */
      conn.send({ type: 'name', name: this.myName });

      /* If we are already sharing screen, let the new peer know */
      if (this.isSharing) conn.send({ type: 'screen-start' });
    });

    conn.on('data', data => this._onData(pid, data));
    conn.on('close', () => this._removePeer(pid));
    conn.on('error', e => console.error('[data]', e));

    const existing = this.connections.get(pid) || {};
    this.connections.set(pid, { ...existing, dataConn: conn });
  }

  /* ── Incoming data message ─────────────────────────────────────────────── */
  _onData(fromId, data) {
    switch (data.type) {

      case 'name': {
        const c = this.connections.get(fromId) || {};
        c.remoteName = data.name;
        this.connections.set(fromId, c);
        const lbl = document.querySelector(`#tile-${CSS.escape(fromId)} .tile-label`);
        if (lbl) lbl.textContent = data.name;
        break;
      }

      case 'peer-list':
        data.peers.forEach(pid => { if (!this.connections.has(pid)) this._callPeer(pid); });
        break;

      case 'new-peer':
        if (!this.connections.has(data.peerId)) this._callPeer(data.peerId);
        break;

      case 'chat':
        this._displayMsg(data.sender, data.text, false);
        break;

      case 'screen-start': {
        const c = this.connections.get(fromId) || {};
        c.isSharing = true;
        this.connections.set(fromId, c);
        const tile = document.getElementById(`tile-${fromId}`);
        if (tile) tile.classList.add('sharing');
        /* Show "request control" button if that person is sharing */
        this._updateControlBtn();
        break;
      }

      case 'screen-stop': {
        const c = this.connections.get(fromId) || {};
        c.isSharing = false;
        this.connections.set(fromId, c);
        const tile = document.getElementById(`tile-${fromId}`);
        if (tile) tile.classList.remove('sharing');
        if (this.ctrlTarget === fromId) this._stopControl();
        this._updateControlBtn();
        break;
      }

      case 'control-request': {
        this.ctrlRequester = fromId;
        const c = this.connections.get(fromId);
        document.getElementById('toast-requester').textContent = c?.remoteName || 'Alguien';
        document.getElementById('control-toast').style.display = 'flex';
        break;
      }

      case 'control-grant':
        this._activateControl(fromId);
        break;

      case 'control-revoke':
        this._stopControl();
        break;

      case 'cursor': {
        const tile = document.getElementById(`tile-${fromId}`);
        if (!tile) break;
        let cur = tile.querySelector('.remote-cursor');
        if (!cur) {
          cur = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          cur.setAttribute('width', '24'); cur.setAttribute('height', '24');
          cur.setAttribute('viewBox', '0 0 24 24');
          cur.innerHTML = '<path d="M4 0l16 12-7 1-4 8z" fill="#8ab4f8" stroke="#fff" stroke-width="1"/>';
          cur.classList.add('remote-cursor');
          tile.appendChild(cur);
        }
        cur.style.left = (data.x * 100) + '%';
        cur.style.top  = (data.y * 100) + '%';
        break;
      }

      case 'click': {
        const tile = document.getElementById(`tile-${fromId}`);
        if (!tile) break;
        const ring = document.createElement('div');
        ring.className = 'remote-click-ring';
        ring.style.left = (data.x * 100) + '%';
        ring.style.top  = (data.y * 100) + '%';
        tile.appendChild(ring);
        setTimeout(() => ring.remove(), 600);
        break;
      }
    }
  }

  /* ── Tiles ─────────────────────────────────────────────────────────────── */
  _addLocalTile() {
    const tile = this._makeTile('local', 'Yo (tú)');
    const video = tile.querySelector('video');
    video.muted = true;
    video.srcObject = this.localStream;
    video.play().catch(() => {});
    if (this.isCamOff) tile.classList.add('cam-off');
    this._addToGrid(tile);
  }

  _addRemoteTile(pid, stream, name) {
    /* Remove existing tile first if any */
    document.getElementById(`tile-${pid}`)?.remove();

    const tile = this._makeTile(pid, name);
    const video = tile.querySelector('video');
    video.srcObject = stream;
    video.play().catch(() => {});
    this._addToGrid(tile);
  }

  _makeTile(pid, name) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.id = `tile-${pid}`;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsinline = true;

    const avatar = document.createElement('div');
    avatar.className = 'tile-avatar';
    const circle = document.createElement('div');
    circle.className = 'avatar-circle';
    circle.textContent = (name || '?')[0];
    avatar.appendChild(circle);

    const label = document.createElement('div');
    label.className = 'tile-label';
    label.textContent = name;

    const mutedIcon = document.createElement('div');
    mutedIcon.className = 'tile-muted';
    mutedIcon.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.34 3 3 3 .23 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V20c0 .55.45 1 1 1s1-.45 1-1v-2.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg>`;

    const shareBadge = document.createElement('div');
    shareBadge.className = 'tile-screenshare-badge';
    shareBadge.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M20 18c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4z"/></svg> Pantalla`;

    tile.appendChild(video);
    tile.appendChild(avatar);
    tile.appendChild(label);
    tile.appendChild(mutedIcon);
    tile.appendChild(shareBadge);
    return tile;
  }

  _addToGrid(tile) {
    const grid = document.getElementById('video-grid');
    /* Remove waiting state placeholder if present */
    grid.querySelector('.waiting-state')?.remove();
    grid.appendChild(tile);
    this._updateGridLayout();
  }

  _removePeer(pid) {
    document.getElementById(`tile-${pid}`)?.remove();
    this.connections.delete(pid);
    this._updateGridLayout();
    this._updateControlBtn();
    if (this.ctrlTarget === pid) this._stopControl();
  }

  _updateGridLayout() {
    const grid = document.getElementById('video-grid');
    const count = grid.querySelectorAll('.tile').length;
    grid.setAttribute('data-count', count || 1);

    /* If local only, show waiting hint */
    if (count <= 1) {
      if (!grid.querySelector('.waiting-state')) {
        const ws = document.createElement('div');
        ws.className = 'waiting-state';
        ws.innerHTML = `<svg width="64" height="64" viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg><p>Comparte el enlace para que alguien se una</p>`;
        grid.appendChild(ws);
      }
    } else {
      grid.querySelector('.waiting-state')?.remove();
    }
  }

  /* ── Screen sharing ────────────────────────────────────────────────────── */
  async _toggleScreen() {
    if (this.isSharing) {
      this._stopScreen();
    } else {
      await this._startScreen();
    }
  }

  async _startScreen() {
    try {
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always', displaySurface: 'monitor' },
        audio: false,
      });
    } catch { return; }

    this.isSharing = true;
    const screenTrack = this.screenStream.getVideoTracks()[0];

    /* Replace video track in all active peer connections */
    this.connections.forEach(({ call }) => {
      if (!call?.peerConnection) return;
      const sender = call.peerConnection.getSenders().find(s => s.track?.kind === 'video');
      if (sender) sender.replaceTrack(screenTrack).catch(() => {});
    });

    /* Show "you are sharing" placeholder on local tile.
       Do NOT preview the screen stream locally — capturing the monitor
       while showing it on the same screen creates an infinite mirror. */
    document.getElementById('tile-local')?.classList.add('sharing-self');

    /* Mark screenshare button as active */
    document.getElementById('btn-screen').classList.add('active-ctrl');

    /* Show top banner */
    document.getElementById('share-banner').style.display = 'flex';

    /* Notify peers */
    this._broadcast({ type: 'screen-start' });

    /* Handle user stopping via browser's built-in stop button */
    screenTrack.onended = () => this._stopScreen();
  }

  _stopScreen() {
    if (!this.isSharing) return;
    this.isSharing = false;

    this.screenStream?.getTracks().forEach(t => t.stop());
    this.screenStream = null;

    /* Restore camera track for remote peers */
    const camTrack = this.localStream?.getVideoTracks()[0];
    this.connections.forEach(({ call }) => {
      if (!call?.peerConnection) return;
      const sender = call.peerConnection.getSenders().find(s => s.track?.kind === 'video');
      if (sender && camTrack) sender.replaceTrack(camTrack).catch(() => {});
    });

    document.getElementById('tile-local')?.classList.remove('sharing-self');
    document.getElementById('btn-screen').classList.remove('active-ctrl');
    document.getElementById('share-banner').style.display = 'none';

    this._broadcast({ type: 'screen-stop' });
  }

  /* ── Remote control ────────────────────────────────────────────────────── */
  _updateControlBtn() {
    /* Show control button if any remote peer is currently sharing their screen */
    const anySharing = [...this.connections.values()].some(c => c.isSharing);
    const item = document.getElementById('ctrl-item');
    item.style.display = anySharing ? 'flex' : 'none';
    if (!anySharing && this.ctrlGranted) this._stopControl();
  }

  _requestControl() {
    /* Find first peer that is sharing */
    const target = [...this.connections.entries()].find(([, c]) => c.isSharing)?.[0];
    if (!target) return;
    this.ctrlTarget = target;
    const c = this.connections.get(target);
    c?.dataConn?.send({ type: 'control-request' });
  }

  _activateControl(fromId) {
    this.ctrlGranted = true;
    this.ctrlTarget  = fromId;
    document.getElementById('btn-control').classList.add('active-ctrl');

    /* Attach mouse listeners to the remote tile */
    const tile = document.getElementById(`tile-${fromId}`);
    if (!tile) return;
    tile.style.cursor = 'crosshair';

    this._onMouseMove = e => {
      const r = tile.getBoundingClientRect();
      this._sendCtrl(fromId, { type: 'cursor', x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
    };
    this._onMouseClick = e => {
      const r = tile.getBoundingClientRect();
      this._sendCtrl(fromId, { type: 'click', x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
    };

    tile.addEventListener('mousemove', this._onMouseMove);
    tile.addEventListener('click',     this._onMouseClick);
  }

  _stopControl() {
    if (this.ctrlTarget) {
      const tile = document.getElementById(`tile-${this.ctrlTarget}`);
      if (tile) {
        tile.style.cursor = '';
        if (this._onMouseMove)  tile.removeEventListener('mousemove', this._onMouseMove);
        if (this._onMouseClick) tile.removeEventListener('click',     this._onMouseClick);
      }
    }
    this.ctrlGranted = false;
    this.ctrlTarget  = null;
    document.getElementById('btn-control').classList.remove('active-ctrl');
  }

  _sendCtrl(peerId, data) {
    const c = this.connections.get(peerId);
    if (c?.dataConn?.open) c.dataConn.send(data);
  }

  /* ── Chat ──────────────────────────────────────────────────────────────── */
  _sendMessage() {
    const input = document.getElementById('chat-input');
    const text  = input.value.trim();
    if (!text) return;
    input.value = '';
    this._broadcast({ type: 'chat', sender: this.myName, text });
    this._displayMsg('Tú', text, true);
  }

  _displayMsg(sender, text, own) {
    const box = document.getElementById('chat-messages');
    box.querySelector('.chat-empty')?.remove();

    const wrap = document.createElement('div');
    wrap.className = `message ${own ? 'own' : 'other'}`;

    const senderEl = document.createElement('div');
    senderEl.className = 'msg-sender';
    senderEl.textContent = sender;

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.textContent = text;   // textContent = safe (no XSS)

    const time = document.createElement('div');
    time.className = 'msg-time';
    time.textContent = fmtTime();

    wrap.appendChild(senderEl);
    wrap.appendChild(bubble);
    wrap.appendChild(time);
    box.appendChild(wrap);
    box.scrollTop = box.scrollHeight;

    if (!this.chatOpen && !own) {
      this.unread++;
      const badge = document.getElementById('chat-badge');
      badge.textContent = this.unread > 9 ? '9+' : this.unread;
      badge.style.display = 'flex';
    }
  }

  _toggleChat() {
    this.chatOpen = !this.chatOpen;
    document.getElementById('chat-panel').classList.toggle('open', this.chatOpen);
    document.getElementById('btn-chat').classList.toggle('active-ctrl', this.chatOpen);
    if (this.chatOpen) {
      this.unread = 0;
      document.getElementById('chat-badge').style.display = 'none';
      document.getElementById('chat-input').focus();
    }
  }

  /* ── Broadcast to all peers ────────────────────────────────────────────── */
  _broadcast(data, excludeId) {
    this.connections.forEach(({ dataConn }, pid) => {
      if (pid !== excludeId && dataConn?.open) dataConn.send(data);
    });
  }

  /* ── UI helpers ────────────────────────────────────────────────────────── */
  _syncMicBtn() {
    document.getElementById('btn-mic').classList.toggle('off', this.isMuted);
  }

  _syncCamBtn() {
    document.getElementById('btn-cam').classList.toggle('off', this.isCamOff);
    document.getElementById('tile-local')?.classList.toggle('cam-off', this.isCamOff);
  }

  _setStatus(online, msg) {
    const dot  = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    dot.className  = 'dot ' + (online ? 'dot-live' : 'dot-error');
    text.textContent = msg || (online ? 'Conectado' : 'Sin conexión');
  }

  _setInviteLink(hostId) {
    const url = location.origin + location.pathname + '?join=' + hostId;
    document.getElementById('invite-link').value = url;
  }

  _startClock() {
    const el = document.getElementById('clock');
    el.textContent = fmtTime();
    setInterval(() => { el.textContent = fmtTime(); }, 10000);
  }

  /* ── UI bindings ───────────────────────────────────────────────────────── */
  _bindUI() {
    /* Mic */
    document.getElementById('btn-mic').addEventListener('click', () => {
      this.isMuted = !this.isMuted;
      this.localStream?.getAudioTracks().forEach(t => { t.enabled = !this.isMuted; });
      this._syncMicBtn();
    });

    /* Camera */
    document.getElementById('btn-cam').addEventListener('click', () => {
      this.isCamOff = !this.isCamOff;
      this.localStream?.getVideoTracks().forEach(t => { t.enabled = !this.isCamOff; });
      this._syncCamBtn();
    });

    /* Screen share */
    document.getElementById('btn-screen').addEventListener('click', () => this._toggleScreen());
    document.getElementById('btn-stop-banner').addEventListener('click', () => this._stopScreen());

    /* Remote control button */
    document.getElementById('btn-control').addEventListener('click', () => {
      if (this.ctrlGranted) {
        /* Release control */
        this._sendCtrl(this.ctrlTarget, { type: 'control-revoke' });
        this._stopControl();
      } else {
        this._requestControl();
      }
    });

    /* Chat toggle */
    document.getElementById('btn-chat').addEventListener('click', () => this._toggleChat());
    document.getElementById('btn-close-chat').addEventListener('click', () => {
      this.chatOpen = true;
      this._toggleChat();
    });

    /* Send message */
    document.getElementById('btn-send').addEventListener('click', () => this._sendMessage());
    document.getElementById('chat-input').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._sendMessage(); }
    });

    /* End call */
    document.getElementById('btn-end').addEventListener('click', () => {
      if (confirm('¿Salir de la reunión?')) {
        this.connections.forEach(({ call, dataConn }) => {
          call?.close();
          dataConn?.close();
        });
        this.peer?.destroy();
        this.localStream?.getTracks().forEach(t => t.stop());
        document.body.innerHTML = `<div style="height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:#202124;color:#e8eaed;font-family:sans-serif"><svg width="64" height="64" viewBox="0 0 24 24" fill="#ea4335"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7 0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.1-.7-.28-.79-.73-1.68-1.36-2.66-1.85-.33-.16-.56-.51-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/></svg><h2>Has salido de la reunión</h2><button onclick="location.href=location.pathname" style="padding:10px 24px;border-radius:8px;border:none;background:#1a73e8;color:#fff;font-size:15px;cursor:pointer">Volver a unirse</button></div>`;
      }
    });

    /* Invite link modal */
    document.getElementById('btn-share-link').addEventListener('click', () => {
      if (this.isHost) {
        this._setInviteLink(this.myId);
      }
      document.getElementById('invite-modal').style.display = 'flex';
    });

    document.getElementById('btn-close-modal').addEventListener('click', () => {
      document.getElementById('invite-modal').style.display = 'none';
    });

    document.getElementById('invite-modal').addEventListener('click', e => {
      if (e.target === document.getElementById('invite-modal'))
        document.getElementById('invite-modal').style.display = 'none';
    });

    document.getElementById('btn-copy-link').addEventListener('click', () => {
      const link = document.getElementById('invite-link').value;
      navigator.clipboard.writeText(link).then(() => {
        document.getElementById('copy-confirm').style.display = 'block';
        setTimeout(() => { document.getElementById('copy-confirm').style.display = 'none'; }, 2500);
      });
    });

    /* Control toast */
    document.getElementById('btn-grant-control').addEventListener('click', () => {
      document.getElementById('control-toast').style.display = 'none';
      const c = this.connections.get(this.ctrlRequester);
      c?.dataConn?.send({ type: 'control-grant' });
    });

    document.getElementById('btn-deny-control').addEventListener('click', () => {
      document.getElementById('control-toast').style.display = 'none';
      this.ctrlRequester = null;
    });
  }
}

/* ── Boot ────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => { window._app = new MeetGreet(); });
