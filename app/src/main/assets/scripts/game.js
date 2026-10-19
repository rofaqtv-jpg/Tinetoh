const canvas = document.getElementById("canvas");

const engine = new BABYLON.Engine(canvas, true, {
    stencil: true,
    adaptToDeviceRatio: true
});

let myId = Math.random().toString(36).substring(2, 10);
let myName = "Player";

if (typeof AndroidBridge !== "undefined") {
    if (AndroidBridge.getDeviceName) {
        myName = AndroidBridge.getDeviceName();
    }

    if (AndroidBridge.getMyId) {
        myId = AndroidBridge.getMyId();
    }
}

const devices = new Map();
const players = new Map();
const remoteCars = new Map();

let devicePanel = null;
let playerPanel = null;
let logElement = null;

let lastSendTime = 0;

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

class Wheel {
    constructor(offset, steer, drive, handbrake) {
        this.offset = offset;
        this.steer = steer;
        this.drive = drive;
        this.handbrake = handbrake;

        this.radius = 0.42;
        this.restLength = 0.38;
        this.lastLength = this.restLength;
    }
}

class RemoteCar {
    constructor(scene, id) {
        this.id = id;

        this.mesh = BABYLON.MeshBuilder.CreateBox(
            "remote_" + id,
            {
                width: 2,
                height: 1,
                depth: 4
            },
            scene
        );

        const material = new BABYLON.StandardMaterial("remoteMat_" + id, scene);
        material.diffuseColor = new BABYLON.Color3(0.2, 0.7, 1.0);
        this.mesh.material = material;

        this.targetPosition = new BABYLON.Vector3(0, 2, 0);
        this.targetRotation = BABYLON.Quaternion.Identity();
    }

    setState(x, y, z, qx, qy, qz, qw) {
        this.targetPosition.set(x, y, z);
        this.targetRotation.set(qx, qy, qz, qw);
    }

    update(dt) {
        const alpha = clamp(dt * 10, 0, 1);

        this.mesh.position = BABYLON.Vector3.Lerp(
            this.mesh.position,
            this.targetPosition,
            alpha
        );

        const currentRotation =
            this.mesh.rotationQuaternion || BABYLON.Quaternion.Identity();

        this.mesh.rotationQuaternion = BABYLON.Quaternion.Slerp(
            currentRotation,
            this.targetRotation,
            alpha
        );
    }

    dispose() {
        if (this.mesh) {
            this.mesh.dispose();
        }
    }
}

class HavokCar {
    constructor(scene, mesh, aggregate) {
        this.scene = scene;
        this.mesh = mesh;
        this.body = aggregate.body;

        this.steerInput = 0;
        this.throttleInput = 0;
        this.brakeInput = 0;
        this.handbrake = false;

        this.engineForce = 7200;
        this.brakeForce = 9000;
        this.maxSteer = 0.55;
        this.steerStrength = 2.6;

        this.suspensionStiffness = 26000;
        this.suspensionDamping = 2600;
        this.maxSuspensionForce = 35000;

        this.normalGrip = 950;
        this.driftGrip = 220;
        this.rollingResistance = 55;

        this.wheels = [
            new Wheel(new BABYLON.Vector3(0.9, -0.35, 1.45), true, false, false),
            new Wheel(new BABYLON.Vector3(-0.9, -0.35, 1.45), true, false, false),
            new Wheel(new BABYLON.Vector3(0.9, -0.35, -1.45), false, true, true),
            new Wheel(new BABYLON.Vector3(-0.9, -0.35, -1.45), false, true, true)
        ];
    }

    reset() {
        this.mesh.position.set(0, 2, 0);
        this.mesh.rotation.set(0, 0, 0);

        if (this.mesh.rotationQuaternion) {
            this.mesh.rotationQuaternion.copyFrom(BABYLON.Quaternion.Identity());
        }

        if (this.body) {
            this.body.setLinearVelocity(new BABYLON.Vector3(0, 0, 0));
            this.body.setAngularVelocity(new BABYLON.Vector3(0, 0, 0));
        }

        this.steerInput = 0;
        this.throttleInput = 0;
        this.brakeInput = 0;
        this.handbrake = false;
    }

    update(delta) {
        if (!this.body) {
            return;
        }

        const dt = Math.min(delta, 1 / 30);

        const physicsEngine = this.scene.getPhysicsEngine();

        if (!physicsEngine) {
            return;
        }

        const worldMatrix = this.mesh.getWorldMatrix();
        const center = this.mesh.position.clone();

        const up = BABYLON.Vector3.TransformNormal(
            new BABYLON.Vector3(0, 1, 0),
            worldMatrix
        ).normalize();

        const forward = BABYLON.Vector3.TransformNormal(
            new BABYLON.Vector3(0, 0, 1),
            worldMatrix
        ).normalize();

        const linearVelocity = this.body.getLinearVelocity();
        const angularVelocity = this.body.getAngularVelocity();

        const speed = linearVelocity.length();

        const handbrakeSteerBoost = this.handbrake ? 1.45 : 1.0;
        const steerEffect = clamp(speed / 7, 0, 1) * handbrakeSteerBoost;

        angularVelocity.y +=
            this.steerInput * this.steerStrength * steerEffect * dt;

        this.body.setAngularVelocity(angularVelocity);

        const reducedAngular = this.body.getAngularVelocity();
        reducedAngular.x *= 0.98;
        reducedAngular.z *= 0.98;
        reducedAngular.y *= this.handbrake ? 0.99 : 0.985;
        this.body.setAngularVelocity(reducedAngular);

        for (let i = 0; i < this.wheels.length; i++) {
            const wheel = this.wheels[i];

            const wheelCenter = BABYLON.Vector3.TransformCoordinates(
                wheel.offset,
                worldMatrix
            );

            const traceEnd = wheelCenter.add(
                up.scale(-(wheel.restLength + wheel.radius))
            );

            let raycastResult;

            try {
                raycastResult = new BABYLON.PhysicsRaycastResult();
                physicsEngine.raycast(wheelCenter, traceEnd, raycastResult);
            } catch (e) {
                wheel.lastLength = wheel.restLength;
                continue;
            }

            if (!raycastResult.hasHit) {
                wheel.lastLength = wheel.restLength;
                continue;
            }

            const hitPoint = raycastResult.hitPointWorld;

            const distance = BABYLON.Vector3.Distance(wheelCenter, hitPoint);

            const suspensionLength = clamp(
                distance - wheel.radius,
                0,
                wheel.restLength
            );

            const compression = wheel.restLength - suspensionLength;

            const lengthVelocity =
                (wheel.lastLength - suspensionLength) / Math.max(dt, 0.001);

            let suspensionForce =
                compression * this.suspensionStiffness +
                lengthVelocity * this.suspensionDamping;

            suspensionForce = clamp(
                suspensionForce,
                -this.maxSuspensionForce,
                this.maxSuspensionForce
            );

            const suspensionImpulse = up.scale(suspensionForce * dt);
            this.body.applyImpulse(suspensionImpulse, hitPoint);

            wheel.lastLength = suspensionLength;

            let wheelForward = forward.clone();

            if (wheel.steer) {
                const steerAngle = this.steerInput * this.maxSteer;

                const steerMatrix = BABYLON.Matrix.RotationAxis(
                    up,
                    steerAngle
                );

                wheelForward = BABYLON.Vector3.TransformNormal(
                    wheelForward,
                    steerMatrix
                ).normalize();
            }

            if (wheel.drive && Math.abs(this.throttleInput) > 0.01) {
                const engineImpulse = wheelForward.scale(
                    this.throttleInput * this.engineForce * dt
                );

                this.body.applyImpulse(engineImpulse, hitPoint);
            }

            const relative = hitPoint.subtract(center);

            const pointVelocity = linearVelocity.add(
                BABYLON.Vector3.Cross(angularVelocity, relative)
            );

            const lateral = BABYLON.Vector3.Cross(up, wheelForward).normalize();

            const lateralSpeed = pointVelocity.dot(lateral);

            let grip = this.normalGrip;

            if (wheel.handbrake && this.handbrake) {
                grip = this.driftGrip;
            }

            const lateralImpulse = lateral.scale(
                -lateralSpeed * grip * dt
            );

            this.body.applyImpulse(lateralImpulse, hitPoint);

            const forwardSpeed = pointVelocity.dot(wheelForward);

            let braking = this.brakeInput > 0;

            if (wheel.handbrake && this.handbrake) {
                braking = true;
            }

            if (braking) {
                const brakeImpulse = wheelForward.scale(
                    -forwardSpeed * this.brakeForce * dt
                );

                this.body.applyImpulse(brakeImpulse, hitPoint);
            }

            const rollingImpulse = wheelForward.scale(
                -forwardSpeed * this.rollingResistance * dt
            );

            this.body.applyImpulse(rollingImpulse, hitPoint);
        }
    }
}

async function createScene() {

    const scene = new BABYLON.Scene(engine);

    scene.clearColor = new BABYLON.Color4(0.55, 0.75, 1.0, 1.0);

    const camera = new BABYLON.ArcRotateCamera(
        "camera",
        Math.PI / 2,
        Math.PI / 3,
        10,
        new BABYLON.Vector3(0, 1, 0),
        scene
    );

    camera.attachControl(canvas, true);
    camera.lowerRadiusLimit = 3;
    camera.upperRadiusLimit = 45;
    camera.panningSensibility = 0;

    const hemiLight = new BABYLON.HemisphericLight(
        "hemiLight",
        new BABYLON.Vector3(0, 1, 0),
        scene
    );

    hemiLight.intensity = 0.9;

    const dirLight = new BABYLON.DirectionalLight(
        "dirLight",
        new BABYLON.Vector3(-0.8, -1, -0.4),
        scene
    );

    dirLight.intensity = 0.8;

    const ground = BABYLON.MeshBuilder.CreateGround(
        "ground",
        {
            width: 400,
            height: 400
        },
        scene
    );

    const groundMaterial = new BABYLON.StandardMaterial("groundMat", scene);
    groundMaterial.diffuseColor = new BABYLON.Color3(0.24, 0.26, 0.3);
    ground.material = groundMaterial;

    const hk = await HavokPhysics();

    scene.enablePhysics(
        new BABYLON.Vector3(0, -9.81, 0),
        new BABYLON.HavokPlugin(true, hk)
    );

    new BABYLON.PhysicsAggregate(
        ground,
        BABYLON.PhysicsShapeType.BOX,
        { mass: 0 },
        scene
    );

    const carMesh = BABYLON.MeshBuilder.CreateBox(
        "car",
        {
            width: 2,
            height: 1,
            depth: 4
        },
        scene
    );

    carMesh.position.set(0, 2, 0);

    const carMaterial = new BABYLON.StandardMaterial("carMat", scene);
    carMaterial.diffuseColor = new BABYLON.Color3(1, 0.2, 0.2);
    carMesh.material = carMaterial;

    const carAggregate = new BABYLON.PhysicsAggregate(
        carMesh,
        BABYLON.PhysicsShapeType.BOX,
        {
            mass: 800,
            friction: 0.65
        },
        scene
    );

    const car = new HavokCar(scene, carMesh, carAggregate);

    let currentVisual = null;

    function disposeCurrentVisual() {
        if (currentVisual) {
            currentVisual.dispose();
            currentVisual = null;
        }
    }

    function selectBuiltInCar(colorHex) {
        disposeCurrentVisual();

        carMaterial.alpha = 1.0;
        carMaterial.diffuseColor = BABYLON.Color3.FromHexString(colorHex);

        try {
            localStorage.setItem("carColor", colorHex);
        } catch (e) {
        }

        setLog("Car selected");
    }

    async function loadCarFromFile(file) {
        disposeCurrentVisual();

        try {
            const objectUrl = URL.createObjectURL(file);

            const container = await BABYLON.SceneLoader.LoadAssetContainerAsync(
                "",
                objectUrl,
                scene
            );

            currentVisual = container;

            const root = container.createRootMesh();
            root.parent = carMesh;

            const bounds = root.getHierarchyBoundingVectors();
            const size = bounds.max.subtract(bounds.min);

            const maxDim = Math.max(size.x, size.y, size.z);

            if (maxDim > 0) {
                root.scaling.setAll(4.2 / maxDim);
            }

            const bounds2 = root.getHierarchyBoundingVectors();
            const center = bounds2.min.add(bounds2.max).scale(0.5);

            root.position = root.position.subtract(center);
            root.position.y += 0.45;

            carMaterial.alpha = 0.0;

            URL.revokeObjectURL(objectUrl);

            setLog("Loaded " + file.name);

        } catch (error) {
            console.error(error);
            carMaterial.alpha = 1.0;
            setLog("Failed to load model");
        }
    }

    try {
        const savedColor = localStorage.getItem("carColor");

        if (savedColor) {
            selectBuiltInCar(savedColor);
        }
    } catch (e) {
    }

    scene.onBeforeRenderObservable.add(() => {
        const dt = engine.getDeltaTime() / 1000;

        car.update(dt);

        const now = performance.now();

        if (now - lastSendTime > 50) {
            lastSendTime = now;

            const q = carMesh.rotationQuaternion || BABYLON.Quaternion.Identity();

            const state = {
                t: "state",
                id: myId,
                x: carMesh.position.x,
                y: carMesh.position.y,
                z: carMesh.position.z,
                qx: q.x,
                qy: q.y,
                qz: q.z,
                qw: q.w
            };

            if (typeof AndroidBridge !== "undefined" && AndroidBridge.send) {
                AndroidBridge.send(JSON.stringify(state));
            }
        }

        remoteCars.forEach((remoteCar) => {
            remoteCar.update(dt);
        });
    });

    window.NetworkBridge = {

        receive(json) {
            try {
                const message = JSON.parse(json);

                if (message.t === "welcome") {
                    players.clear();

                    addPlayer(myId, myName);

                    if (message.hostId) {
                        addPlayer(message.hostId, "Host");
                    }

                    if (Array.isArray(message.players)) {
                        message.players.forEach((player) => {
                            addPlayer(player.id, player.name);
                        });
                    }

                    setLog("Connected to host");
                    return;
                }

                if (message.t === "playerJoined") {
                    addPlayer(message.id, message.name);
                    setLog(message.name + " joined");
                    return;
                }

                if (message.t === "playerLeft") {
                    removePlayer(message.id);
                    return;
                }

                if (message.t === "state") {
                    if (message.id === myId) {
                        return;
                    }

                    let remoteCar = remoteCars.get(message.id);

                    if (!remoteCar) {
                        remoteCar = new RemoteCar(scene, message.id);
                        remoteCars.set(message.id, remoteCar);
                    }

                    remoteCar.setState(
                        message.x,
                        message.y,
                        message.z,
                        message.qx,
                        message.qy,
                        message.qz,
                        message.qw
                    );
                }

            } catch (error) {
                console.warn(error);
            }
        },

        onDeviceFound(name, host, port) {
            devices.set(name, {
                name,
                host,
                port
            });

            renderDevices();
        },

        onDeviceLost(name) {
            devices.delete(name);
            renderDevices();
        },

        onLog(message) {
            setLog(message);
        }
    };

    createHUD(car);
    createSteeringWheel(car);
    createCarSelector(scene, carMesh, selectBuiltInCar, loadCarFromFile);
    createNetworkUI();

    engine.runRenderLoop(() => {
        scene.render();
    });

    window.addEventListener("resize", () => {
        engine.resize();
    });
}

function addPlayer(id, name) {
    if (!id) return;

    players.set(id, name || "Player");
    renderPlayers();
}

function removePlayer(id) {
    players.delete(id);

    const remoteCar = remoteCars.get(id);

    if (remoteCar) {
        remoteCar.dispose();
        remoteCars.delete(id);
    }

    renderPlayers();
}

function renderPlayers() {
    if (!playerPanel) return;

    playerPanel.innerHTML = "";

    players.forEach((name, id) => {
        const item = document.createElement("div");

        item.style.padding = "4px";
        item.style.color = "white";
        item.style.fontFamily = "sans-serif";
        item.style.fontSize = "14px";

        item.textContent = name + (id === myId ? " (You)" : "");

        playerPanel.appendChild(item);
    });
}

function renderDevices() {
    if (!devicePanel) return;

    devicePanel.innerHTML = "";

    devices.forEach((device) => {
        const button = document.createElement("button");

        button.textContent = "Join " + device.name;

        button.onclick = () => {
            if (typeof AndroidBridge !== "undefined" && AndroidBridge.join) {
                AndroidBridge.join(device.host, device.port);
                setLog("Joining " + device.name);
            }
        };

        devicePanel.appendChild(button);
    });
}

function createNetworkUI() {

    const panel = document.createElement("div");

    panel.style.position = "absolute";
    panel.style.top = "10px";
    panel.style.left = "10px";
    panel.style.zIndex = "30";
    panel.style.display = "flex";
    panel.style.flexDirection = "column";
    panel.style.gap = "8px";
    panel.style.fontFamily = "sans-serif";

    const hostButton = document.createElement("button");
    hostButton.textContent = "Host";

    hostButton.onclick = () => {
        players.clear();
        addPlayer(myId, myName);

        if (typeof AndroidBridge !== "undefined" && AndroidBridge.startHost) {
            AndroidBridge.startHost();
            setLog("Starting host...");
        }
    };

    const discoverButton = document.createElement("button");
    discoverButton.textContent = "Discover";

    discoverButton.onclick = () => {
        if (typeof AndroidBridge !== "undefined" && AndroidBridge.discover) {
            AndroidBridge.discover();
            setLog("Searching for devices...");
        }
    };

    devicePanel = document.createElement("div");
    devicePanel.style.display = "flex";
    devicePanel.style.flexDirection = "column";
    devicePanel.style.gap = "6px";

    playerPanel = document.createElement("div");
    playerPanel.style.marginTop = "10px";
    playerPanel.style.border = "1px solid rgba(255,255,255,0.25)";
    playerPanel.style.padding = "6px";
    playerPanel.style.borderRadius = "8px";
    playerPanel.style.minWidth = "160px";

    panel.appendChild(hostButton);
    panel.appendChild(discoverButton);
    panel.appendChild(devicePanel);
    panel.appendChild(playerPanel);

    document.body.appendChild(panel);
}

function setLog(message) {
    if (!logElement) {
        logElement = document.createElement("div");

        logElement.style.position = "absolute";
        logElement.style.top = "10px";
        logElement.style.right = "10px";
        logElement.style.zIndex = "40";
        logElement.style.color = "white";
        logElement.style.background = "rgba(0,0,0,0.5)";
        logElement.style.padding = "8px";
        logElement.style.borderRadius = "8px";
        logElement.style.fontFamily = "sans-serif";
        logElement.style.fontSize = "14px";

        document.body.appendChild(logElement);
    }

    logElement.textContent = message;
}

function createHUD(car) {

    const style = document.createElement("style");

    style.textContent = `
        .ctrl-button {
            position: absolute;
            bottom: 20px;
            width: 80px;
            height: 80px;
            border-radius: 18px;
            background: rgba(0, 0, 0, 0.55);
            color: white;
            font-family: sans-serif;
            font-size: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            user-select: none;
            touch-action: none;
        }
    `;

    document.head.appendChild(style);

    function makeButton(text, left, down, up) {
        const button = document.createElement("div");

        button.className = "ctrl-button";
        button.style.left = left;
        button.textContent = text;

        button.addEventListener("pointerdown", (event) => {
            event.preventDefault();
            down();
        });

        button.addEventListener("pointerup", (event) => {
            event.preventDefault();
            up();
        });

        button.addEventListener("pointerleave", () => {
            up();
        });

        document.body.appendChild(button);
    }

    makeButton(
        "GAS",
        "calc(100% - 320px)",
        () => car.throttleInput = 1,
        () => car.throttleInput = 0
    );

    makeButton(
        "BRK",
        "calc(100% - 220px)",
        () => car.brakeInput = 1,
        () => car.brakeInput = 0
    );

    makeButton(
        "HB",
        "calc(100% - 120px)",
        () => car.handbrake = true,
        () => car.handbrake = false
    );
}

function createSteeringWheel(car) {

    const wheel = document.createElement("div");

    wheel.style.position = "absolute";
    wheel.style.bottom = "25px";
    wheel.style.left = "50%";
    wheel.style.width = "140px";
    wheel.style.height = "140px";
    wheel.style.borderRadius = "50%";
    wheel.style.border = "8px solid rgba(255,255,255,0.35)";
    wheel.style.background = "rgba(0,0,0,0.35)";
    wheel.style.zIndex = "20";
    wheel.style.touchAction = "none";
    wheel.style.transform = "translateX(-50%) rotate(0deg)";

    const marker = document.createElement("div");

    marker.style.position = "absolute";
    marker.style.top = "8px";
    marker.style.left = "50%";
    marker.style.width = "12px";
    marker.style.height = "35px";
    marker.style.borderRadius = "8px";
    marker.style.background = "rgba(255,255,255,0.8)";
    marker.style.transform = "translateX(-50%)";

    wheel.appendChild(marker);

    let dragging = false;
    let lastX = 0;
    let steerValue = 0;

    function setVisual(value) {
        wheel.style.transform =
            "translateX(-50%) rotate(" + (value * 120) + "deg)";
    }

    wheel.addEventListener("pointerdown", (event) => {
        dragging = true;
        lastX = event.clientX;
        wheel.setPointerCapture(event.pointerId);
        event.preventDefault();
    });

    wheel.addEventListener("pointermove", (event) => {
        if (!dragging) return;

        const dx = event.clientX - lastX;
        lastX = event.clientX;

        steerValue = clamp(steerValue + dx * 0.01, -1, 1);

        car.steerInput = steerValue;
        setVisual(steerValue);

        event.preventDefault();
    });

    function release() {
        if (!dragging) return;

        dragging = false;
        steerValue = 0;
        car.steerInput = 0;
        setVisual(0);
    }

    wheel.addEventListener("pointerup", release);
    wheel.addEventListener("pointercancel", release);

    document.body.appendChild(wheel);
}

function createCarSelector(scene, carMesh, selectBuiltInCar, loadCarFromFile) {

    const panel = document.createElement("div");

    panel.style.position = "absolute";
    panel.style.top = "10px";
    panel.style.right = "10px";
    panel.style.zIndex = "35";
    panel.style.display = "flex";
    panel.style.flexDirection = "column";
    panel.style.gap = "6px";
    panel.style.fontFamily = "sans-serif";

    const label = document.createElement("div");
    label.textContent = "Car";
    label.style.color = "white";
    label.style.fontSize = "14px";

    const redButton = document.createElement("button");
    redButton.textContent = "Red";
    redButton.onclick = () => selectBuiltInCar("#ff3333");

    const blueButton = document.createElement("button");
    blueButton.textContent = "Blue";
    blueButton.onclick = () => selectBuiltInCar("#3388ff");

    const greenButton = document.createElement("button");
    greenButton.textContent = "Green";
    greenButton.onclick = () => selectBuiltInCar("#33cc66");

    const importButton = document.createElement("button");
    importButton.textContent = "Import GLB";

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".glb,.gltf";
    fileInput.style.display = "none";

    importButton.onclick = () => {
        fileInput.click();
    };

    fileInput.addEventListener("change", async () => {
        if (fileInput.files && fileInput.files[0]) {
            await loadCarFromFile(fileInput.files[0]);
            fileInput.value = "";
        }
    });

    panel.appendChild(label);
    panel.appendChild(redButton);
    panel.appendChild(blueButton);
    panel.appendChild(greenButton);
    panel.appendChild(importButton);

    document.body.appendChild(panel);
    document.body.appendChild(fileInput);
}

createScene();
