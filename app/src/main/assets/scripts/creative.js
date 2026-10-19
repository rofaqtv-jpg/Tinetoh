(function () {

    function waitGameReady(callback) {
        if (window.GameRefs) {
            callback(window.GameRefs);
        } else {
            setTimeout(() => waitGameReady(callback), 100);
        }
    }

    class EngineSound {
        constructor() {
            this.ctx = null;
            this.osc = null;
            this.gain = null;
            this.filter = null;
        }

        init() {
            if (this.ctx) return;

            const AudioContextClass =
                window.AudioContext || window.webkitAudioContext;

            if (!AudioContextClass) return;

            this.ctx = new AudioContextClass();

            this.osc = this.ctx.createOscillator();
            this.osc.type = "sawtooth";

            this.filter = this.ctx.createBiquadFilter();
            this.filter.type = "lowpass";
            this.filter.frequency.value = 700;

            this.gain = this.ctx.createGain();
            this.gain.gain.value = 0;

            this.osc.connect(this.filter);
            this.filter.connect(this.gain);
            this.gain.connect(this.ctx.destination);

            this.osc.start();
        }

        resume() {
            if (this.ctx && this.ctx.state === "suspended") {
                this.ctx.resume();
            }
        }

        setEnabled(enabled) {
            if (!this.ctx) return;

            this.resume();

            if (!enabled) {
                this.gain.gain.setTargetAtTime(
                    0,
                    this.ctx.currentTime,
                    0.03
                );
            }
        }

        update(speed, throttle) {
            if (!this.ctx) return;

            this.resume();

            const frequency =
                70 +
                speed * 9 +
                throttle * 70;

            const volume =
                0.015 +
                throttle * 0.035 +
                Math.min(speed / 40, 0.03);

            this.osc.frequency.setTargetAtTime(
                frequency,
                this.ctx.currentTime,
                0.05
            );

            this.gain.gain.setTargetAtTime(
                volume,
                this.ctx.currentTime,
                0.08
            );
        }
    }

    waitGameReady((refs) => {

        const {
            engine,
            scene,
            camera,
            car,
            carMesh
        } = refs;

        // ===============================
        // 1) جو ليلي / نيون
        // ===============================

        scene.clearColor = new BABYLON.Color4(0.06, 0.07, 0.15, 1);

        scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
        scene.fogDensity = 0.0045;
        scene.fogColor = new BABYLON.Color3(0.07, 0.08, 0.18);

        try {
            camera.setTarget(carMesh);
        } catch (e) {
            camera.target = carMesh;
        }

        camera.upperBetaLimit = 1.45;
        camera.lowerBetaLimit = 0.15;
        camera.lowerRadiusLimit = 4;
        camera.upperRadiusLimit = 70;

        // ===============================
        // 2) عداد السرعة
        // ===============================

        const speedHud = document.createElement("div");

        speedHud.style.position = "absolute";
        speedHud.style.bottom = "130px";
        speedHud.style.right = "20px";
        speedHud.style.zIndex = "50";
        speedHud.style.color = "#ffffff";
        speedHud.style.fontFamily = "sans-serif";
        speedHud.style.fontSize = "22px";
        speedHud.style.fontWeight = "bold";
        speedHud.style.padding = "8px 12px";
        speedHud.style.borderRadius = "12px";
        speedHud.style.background = "rgba(0,0,0,0.45)";
        speedHud.textContent = "0 km/h";

        document.body.appendChild(speedHud);

        // ===============================
        // 3) بناء مدينة / مضمار
        // ===============================

        function makeStandardMaterial(color, emissive) {
            const material = new BABYLON.StandardMaterial(
                "mat_" + Math.random().toString(36).substring(2),
                scene
            );

            material.diffuseColor = color;

            if (emissive) {
                material.emissiveColor = emissive;
            }

            return material;
        }

        function staticBox(
            name,
            width,
            height,
            depth,
            x,
            y,
            z,
            color,
            rotationY = 0,
            rotationX = 0
        ) {
            const mesh = BABYLON.MeshBuilder.CreateBox(
                name,
                {
                    width,
                    height,
                    depth
                },
                scene
            );

            mesh.position.set(x, y, z);
            mesh.rotation.y = rotationY;
            mesh.rotation.x = rotationX;

            mesh.material = makeStandardMaterial(color);

            new BABYLON.PhysicsAggregate(
                mesh,
                BABYLON.PhysicsShapeType.BOX,
                { mass: 0 },
                scene
            );

            return mesh;
        }

        function neonPillar(x, z, color) {
            const mesh = BABYLON.MeshBuilder.CreateBox(
                "pillar_" + Math.random().toString(36).substring(2),
                {
                    width: 0.7,
                    height: 6,
                    depth: 0.7
                },
                scene
            );

            mesh.position.set(x, 3, z);

            mesh.material = makeStandardMaterial(color, color);

            new BABYLON.PhysicsAggregate(
                mesh,
                BABYLON.PhysicsShapeType.BOX,
                { mass: 0 },
                scene
            );
        }

        function createCreativeWorld() {

            const wallColor = new BABYLON.Color3(0.12, 0.16, 0.32);

            // جدران المضمار
            staticBox("wall_north", 240, 6, 3, 0, 3, 120, wallColor);
            staticBox("wall_south", 240, 6, 3, 0, 3, -120, wallColor);
            staticBox("wall_east", 3, 6, 240, 120, 3, 0, wallColor);
            staticBox("wall_west", 3, 6, 240, -120, 3, 0, wallColor);

            // منحدرات
            staticBox(
                "ramp_1",
                16,
                1,
                26,
                0,
                1.5,
                -55,
                new BABYLON.Color3(1, 0.6, 0.15),
                0,
                Math.PI / 14
            );

            staticBox(
                "ramp_2",
                16,
                1,
                26,
                50,
                1.5,
                25,
                new BABYLON.Color3(0.1, 0.9, 0.9),
                Math.PI / 2,
                Math.PI / 18
            );

            staticBox(
                "ramp_3",
                16,
                1,
                26,
                -55,
                1.5,
                50,
                new BABYLON.Color3(0.9, 0.2, 0.8),
                -Math.PI / 3,
                Math.PI / 20
            );

            // عقبات دائرية حول المضمار
            for (let i = 0; i < 14; i++) {
                const angle = i * Math.PI * 2 / 14;

                const x = Math.cos(angle) * 80;
                const z = Math.sin(angle) * 80;

                staticBox(
                    "block_" + i,
                    4,
                    4,
                    4,
                    x,
                    2,
                    z,
                    new BABYLON.Color3(0.35, 0.2, 0.55),
                    angle
                );
            }

            // أعمدة نيون
            for (let i = 0; i < 12; i++) {
                const angle = i * Math.PI * 2 / 12;

                const x = Math.cos(angle) * 105;
                const z = Math.sin(angle) * 105;

                if (i % 3 === 0) {
                    neonPillar(x, z, new BABYLON.Color3(0.1, 0.8, 1));
                } else if (i % 3 === 1) {
                    neonPillar(x, z, new BABYLON.Color3(1, 0.2, 0.8));
                } else {
                    neonPillar(x, z, new BABYLON.Color3(0.2, 1, 0.4));
                }
            }
        }

        createCreativeWorld();

        // ===============================
        // 4) صوت المحرك
        // ===============================

        const engineSound = new EngineSound();
        let soundEnabled = false;

        function makeExtraButton(text, left, bottom, onClick) {
            const button = document.createElement("div");

            button.className = "ctrl-button";
            button.style.left = left;
            button.style.bottom = bottom;
            button.textContent = text;

            button.addEventListener("pointerdown", (event) => {
                event.preventDefault();
                onClick(button);
            });

            document.body.appendChild(button);
        }

        makeExtraButton("RESET", "20px", "120px", () => {
            car.reset();
        });

        makeExtraButton("CAM", "20px", "220px", () => {
            camera.alpha = Math.PI / 2;
            camera.beta = Math.PI / 3;
            camera.radius = 12;

            try {
                camera.setTarget(carMesh);
            } catch (e) {
                camera.target = carMesh;
            }
        });

        makeExtraButton("SND", "20px", "320px", (button) => {
            soundEnabled = !soundEnabled;

            if (soundEnabled) {
                engineSound.init();
                engineSound.resume();
                engineSound.setEnabled(true);

                button.style.background = "rgba(0,140,80,0.55)";
            } else {
                engineSound.setEnabled(false);
                button.style.background = "rgba(0,0,0,0.55)";
            }
        });

        document.addEventListener("pointerdown", () => {
            if (soundEnabled) {
                engineSound.init();
                engineSound.resume();
            }
        });

        // ===============================
        // 5) إعادة تلقائية عند الانقلاب
        // ===============================

        let flipTimer = 0;

        scene.onBeforeRenderObservable.add(() => {

            const dt = engine.getDeltaTime() / 1000;

            let speed = 0;

            if (car.body && car.body.getLinearVelocity) {
                speed = car.body.getLinearVelocity().length();
            }

            speedHud.textContent = Math.round(speed * 3.6) + " km/h";

            if (soundEnabled) {
                engineSound.update(speed, car.throttleInput);
            }

            const carUp = carMesh.getDirection(BABYLON.Axis.Y);

            if (carUp.y < 0.15) {
                flipTimer += dt;
            } else {
                flipTimer = 0;
            }

            if (flipTimer > 2.5) {
                car.reset();
                flipTimer = 0;
            }
        });
    });

})();
