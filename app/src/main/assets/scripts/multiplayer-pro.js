(function () {

    const INTERP_DELAY = 120;
    const NETWORK_TIMEOUT = 3500;

    let refs = null;

    let role = "SOLO";
    let lastNetMessage = 0;
    let wantAddSelf = false;

    const players = new Map();
    const remoteCars = new Map();
    const nameTags = new Map();

    const pendingMessages = [];

    let dotEl = null;
    let statusTextEl = null;
    let countEl = null;

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function injectCss() {
        const style = document.createElement("style");

        style.textContent = `
            .mp-status-panel {
                position: absolute;
                top: 10px;
                left: 50%;
                transform: translateX(-50%);
                z-index: 60;
                display: flex;
                gap: 10px;
                align-items: center;
                background: rgba(0, 0, 0, 0.45);
                color: white;
                padding: 6px 12px;
                border-radius: 12px;
                font-family: sans-serif;
                font-size: 14px;
                pointer-events: none;
            }

            .mp-dot {
                width: 12px;
                height: 12px;
                border-radius: 50%;
                background: #777;
                display: inline-block;
            }

            .mp-name-tag {
                position: absolute;
                z-index: 55;
                transform: translate(-50%, -100%);
                color: white;
                font-family: sans-serif;
                font-size: 13px;
                padding: 2px 8px;
                border-radius: 8px;
                background: rgba(0, 0, 0, 0.45);
                pointer-events: none;
            }
        `;

        document.head.appendChild(style);
    }

    function createUI() {
        const panel = document.createElement("div");
        panel.className = "mp-status-panel";

        dotEl = document.createElement("span");
        dotEl.className = "mp-dot";

        statusTextEl = document.createElement("span");
        statusTextEl.textContent = "Solo";

        countEl = document.createElement("span");
        countEl.textContent = "Players: 0";

        panel.appendChild(dotEl);
        panel.appendChild(statusTextEl);
        panel.appendChild(countEl);

        document.body.appendChild(panel);

        updateStatus();
    }

    class InterpolatedCar {

        constructor(scene, id) {
            this.id = id;
            this.snapshots = [];

            this.mesh = BABYLON.MeshBuilder.CreateBox(
                "mp_remote_" + id,
                {
                    width: 2,
                    height: 1,
                    depth: 4
                },
                scene
            );

            const material = new BABYLON.StandardMaterial(
                "mp_mat_" + id,
                scene
            );

            material.diffuseColor = new BABYLON.Color3(0.2, 0.7, 1.0);

            this.mesh.material = material;
        }

        addState(message) {
            const now = performance.now();

            this.snapshots.push({
                t: now,
                pos: new BABYLON.Vector3(
                    message.x,
                    message.y,
                    message.z
                ),
                rot: new BABYLON.Quaternion(
                    message.qx,
                    message.qy,
                    message.qz,
                    message.qw
                )
            });

            if (this.snapshots.length > 40) {
                this.snapshots.shift();
            }
        }

        update(renderTime) {
            if (this.snapshots.length === 0) {
                return;
            }

            if (this.snapshots.length === 1) {
                const snapshot = this.snapshots[0];

                this.mesh.position.copyFrom(snapshot.pos);
                this.mesh.rotationQuaternion.copyFrom(snapshot.rot);

                return;
            }

            let before = null;
            let after = null;

            for (let i = 0; i < this.snapshots.length; i++) {
                const snapshot = this.snapshots[i];

                if (snapshot.t <= renderTime) {
                    before = snapshot;
                }

                if (snapshot.t > renderTime) {
                    after = snapshot;
                    break;
                }
            }

            if (!before) {
                const first = this.snapshots[0];

                this.mesh.position.copyFrom(first.pos);
                this.mesh.rotationQuaternion.copyFrom(first.rot);

                return;
            }

            if (!after) {
                const age = renderTime - before.t;

                if (age < 250) {
                    this.mesh.position.copyFrom(before.pos);
                    this.mesh.rotationQuaternion.copyFrom(before.rot);
                }

                return;
            }

            const alpha = clamp(
                (renderTime - before.t) / (after.t - before.t),
                0,
                1
            );

            this.mesh.position = BABYLON.Vector3.Lerp(
                before.pos,
                after.pos,
                alpha
            );

            this.mesh.rotationQuaternion = BABYLON.Quaternion.Slerp(
                before.rot,
                after.rot,
                alpha
            );
        }

        dispose() {
            if (this.mesh) {
                this.mesh.dispose();
            }
        }
    }

    function waitRefs(callback) {
        if (
            window.GameRefs &&
            window.GameRefs.scene &&
            window.GameRefs.myId
        ) {
            callback();
        } else {
            setTimeout(() => waitRefs(callback), 100);
        }
    }

    function waitNetworkBridge() {
        if (window.NetworkBridge) {
            patchReceive();
        } else {
            setTimeout(waitNetworkBridge, 50);
        }
    }

    function patchReceive() {
        const bridge = window.NetworkBridge;

        if (!bridge || bridge.__mpPatched) {
            return;
        }

        bridge.__mpPatched = true;

        bridge.receive = function (json) {
            lastNetMessage = performance.now();

            if (!refs) {
                pendingMessages.push(json);
                return;
            }

            processJson(json);
        };
    }

    function patchAndroidBridge() {
        if (!window.AndroidBridge || window.AndroidBridge.__mpPatched) {
            return;
        }

        try {
            const originalStartHost = window.AndroidBridge.startHost;
            const originalJoin = window.AndroidBridge.join;

            if (originalStartHost) {
                window.AndroidBridge.startHost = function () {
                    role = "HOST";
                    wantAddSelf = true;
                    lastNetMessage = performance.now();

                    if (refs) {
                        addPlayer(refs.myId, refs.myName);
                    }

                    return originalStartHost.apply(window.AndroidBridge, arguments);
                };
            }

            if (originalJoin) {
                window.AndroidBridge.join = function (host, port) {
                    role = "JOINING";
                    lastNetMessage = performance.now();

                    return originalJoin.apply(window.AndroidBridge, arguments);
                };
            }

            window.AndroidBridge.__mpPatched = true;

        } catch (e) {
            console.warn("AndroidBridge patch failed", e);
        }
    }

    function init() {
        refs = window.GameRefs;

        injectCss();
        createUI();

        if (role === "HOST" || wantAddSelf) {
            addPlayer(refs.myId, refs.myName);
        }

        flushPendingMessages();

        refs.scene.onBeforeRenderObservable.add(update);

        startHeartbeat();
    }

    function flushPendingMessages() {
        while (pendingMessages.length > 0) {
            const json = pendingMessages.shift();
            processJson(json);
        }
    }

    function processJson(json) {
        try {
            const message = JSON.parse(json);
            handleMessage(message);
        } catch (e) {
        }
    }

    function handleMessage(message) {
        if (!message || !message.t) {
            return;
        }

        if (message.t === "welcome") {
            role = "CLIENT";

            clearRemotePlayers();

            addPlayer(
                message.clientId || refs.myId,
                refs.myName
            );

            if (
                message.hostId &&
                message.hostId !== (message.clientId || refs.myId)
            ) {
                addPlayer(message.hostId, "Host");
            }

            if (Array.isArray(message.players)) {
                message.players.forEach((player) => {
                    if (
                        player.id !==
                        (message.clientId || refs.myId)
                    ) {
                        addPlayer(player.id, player.name);
                    }
                });
            }

            updateStatus();
            return;
        }

        if (message.t === "playerJoined") {
            addPlayer(message.id, message.name);
            return;
        }

        if (message.t === "playerLeft") {
            removePlayer(message.id);
            return;
        }

        if (message.t === "state") {
            if (message.id === refs.myId) {
                return;
            }

            addPlayer(
                message.id,
                message.name || ("Player_" + String(message.id).substring(0, 4))
            );

            markSeen(message.id);
            updateRemoteCar(message);

            return;
        }

        if (message.t === "ping") {
            if (message.id === refs.myId) {
                return;
            }

            addPlayer(
                message.id,
                message.name || ("Player_" + String(message.id).substring(0, 4))
            );

            markSeen(message.id);

            return;
        }
    }

    function addPlayer(id, name) {
        if (!id || !refs) {
            return;
        }

        if (id === refs.myId) {
            players.set(id, {
                id,
                name: name || refs.myName,
                lastSeen: performance.now()
            });

            updateStatus();
            return;
        }

        let player = players.get(id);

        if (!player) {
            player = {
                id,
                name: name || "Player",
                lastSeen: performance.now()
            };

            players.set(id, player);

            createNameTag(id, player.name);
            createRemoteCar(id);

        } else if (name && player.name !== name) {
            player.name = name;
            updateNameTag(id, name);
        }

        player.lastSeen = performance.now();

        updateStatus();
    }

    function removePlayer(id) {
        if (!id) {
            return;
        }

        if (refs && id === refs.myId) {
            return;
        }

        players.delete(id);

        const tag = nameTags.get(id);

        if (tag) {
            tag.remove();
            nameTags.delete(id);
        }

        const car = remoteCars.get(id);

        if (car) {
            car.dispose();
            remoteCars.delete(id);
        }

        updateStatus();
    }

    function clearRemotePlayers() {
        const ids = Array.from(players.keys());

        for (const id of ids) {
            if (refs && id === refs.myId) {
                continue;
            }

            removePlayer(id);
        }
    }

    function markSeen(id) {
        const player = players.get(id);

        if (player) {
            player.lastSeen = performance.now();
        }
    }

    function createRemoteCar(id) {
        if (!refs) {
            return;
        }

        const car = new InterpolatedCar(refs.scene, id);
        remoteCars.set(id, car);
    }

    function updateRemoteCar(message) {
        if (!refs) {
            return;
        }

        let car = remoteCars.get(message.id);

        if (!car) {
            car = new InterpolatedCar(refs.scene, message.id);
            remoteCars.set(message.id, car);
        }

        car.addState(message);
    }

    function createNameTag(id, name) {
        const tag = document.createElement("div");

        tag.className = "mp-name-tag";
        tag.textContent = name;

        document.body.appendChild(tag);

        nameTags.set(id, tag);
    }

    function updateNameTag(id, name) {
        const tag = nameTags.get(id);

        if (tag) {
            tag.textContent = name;
        }
    }

    function update() {
        if (!refs) {
            return;
        }

        const renderTime = performance.now() - INTERP_DELAY;

        remoteCars.forEach((car) => {
            car.update(renderTime);
        });

        updateNameTags();
        updateStatus();
    }

    function updateNameTags() {
        if (!refs || !refs.scene.activeCamera) {
            return;
        }

        const camera = refs.scene.activeCamera;

        const width = refs.engine.getRenderWidth();
        const height = refs.engine.getRenderHeight();

        const transform = camera.getTransformationMatrix();

        const viewport = new BABYLON.Viewport(
            0,
            0,
            width,
            height
        );

        const scaleX = window.innerWidth / width;
        const scaleY = window.innerHeight / height;

        nameTags.forEach((tag, id) => {

            const car = remoteCars.get(id);

            if (!car) {
                tag.style.display = "none";
                return;
            }

            const worldPosition = car.mesh.position.add(
                new BABYLON.Vector3(0, 1.5, 0)
            );

            const projected = BABYLON.Vector3.Project(
                worldPosition,
                BABYLON.Matrix.Identity(),
                transform,
                viewport
            );

            if (projected.z < 0 || projected.z > 1) {
                tag.style.display = "none";
                return;
            }

            tag.style.display = "block";
            tag.style.left = (projected.x * scaleX) + "px";
            tag.style.top = (projected.y * scaleY) + "px";
        });
    }

    function updateStatus() {
        if (!dotEl || !statusTextEl || !countEl) {
            return;
        }

        const now = performance.now();

        let online = false;

        if (role === "HOST") {
            online = true;
        } else if (role === "CLIENT" || role === "JOINING") {
            online = (now - lastNetMessage) < NETWORK_TIMEOUT;
        }

        if (online) {
            dotEl.style.background = "#2ecc71";
        } else if (role === "SOLO") {
            dotEl.style.background = "#777";
        } else {
            dotEl.style.background = "#e74c3c";
        }

        if (role === "SOLO") {
            statusTextEl.textContent = "Solo";
        } else {
            statusTextEl.textContent =
                role + (online ? " | Connected" : " | Waiting");
        }

        countEl.textContent = "Players: " + players.size;
    }

    function startHeartbeat() {
        setInterval(() => {
            if (!refs) {
                return;
            }

            if (role === "HOST" || role === "CLIENT") {

                addPlayer(refs.myId, refs.myName);

                if (window.AndroidBridge && AndroidBridge.send) {
                    AndroidBridge.send(JSON.stringify({
                        t: "ping",
                        id: refs.myId,
                        name: refs.myName
                    }));
                }
            }

        }, 800);
    }

    waitNetworkBridge();
    setInterval(patchAndroidBridge, 500);
    waitRefs(init);

})();
