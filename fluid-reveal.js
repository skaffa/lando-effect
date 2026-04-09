// fluid-reveal.js
import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.module.js';

export default class FluidReveal {
    constructor(config) {
        if (!config.container) throw new Error("FluidReveal: Missing strictly required 'container' option.");
        if (!config.baseTextureUrl) throw new Error("FluidReveal: Missing 'baseTextureUrl'.");
        if (!config.overlayTextureUrl) throw new Error("FluidReveal: Missing 'overlayTextureUrl'.");

        this.container = config.container;

        // Expose robust configurable options while locking in physical mathematical 1:1 parity defaults
        this.options = {
            cursor_size: 18,
            mouse_force: 50,
            resolution: 0.1,
            dt: 0.014,
            dissipation: 0.96,
            iterations: 4,
            ...config.options
        };

        this.baseTextureUrl = config.baseTextureUrl;
        this.overlayTextureUrl = config.overlayTextureUrl;

        this.state = {
            isRunning: false,
            splats: [],
            pointers: [{ x: 0, y: 0 }],
            isMoving: false,
            moveTimeout: null,
            lastMouseCoords: new THREE.Vector2(),
            idleCursorProgress: new THREE.Vector2(),
            idleElapsed: 0,
            simDelta: 0,
            simInterval: 1.0 / 60.0,
            targetParallaxX: 0,
            targetParallaxY: 0,
            prevIdleCursor: new THREE.Vector2()
        };

        this.CYCLE_TIME = 2.5 + 1.5 + 2.5 + 3.0;

        this.boundAnimate = this.animate.bind(this);
        this.boundOnMouseMove = this.onMouseMove.bind(this);
        this.boundOnResize = this.onResize.bind(this);

        this.init();
    }

    init() {
        this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false });
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.autoClear = false;

        // Remove existing canvas if reinitialized
        this.container.innerHTML = '';
        this.container.appendChild(this.renderer.domElement);

        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(45, this.container.clientWidth / this.container.clientHeight, 0.1, 100);
        this.camera.position.z = 2.5;

        this.simResX = Math.round(this.container.clientWidth * this.options.resolution);
        this.simResY = Math.round(this.container.clientHeight * this.options.resolution);

        this.domainScale = new THREE.Vector2(1.0 / 110.0, (this.simResX / this.simResY) / 110.0);

        const FBO_OPTS = {
            format: THREE.RGBAFormat,
            type: THREE.FloatType, // FloatType natively avoids all banding limits
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            wrapS: THREE.ClampToEdgeWrapping,
            wrapT: THREE.ClampToEdgeWrapping,
            depthBuffer: false,
            stencilBuffer: false,
            generateMipmaps: false
        };

        const createRenderTarget = () => new THREE.WebGLRenderTarget(this.simResX, this.simResY, FBO_OPTS);
        const createDoubleRenderTarget = () => ({
            read: createRenderTarget(),
            write: createRenderTarget(),
            swap() { let tmp = this.read; this.read = this.write; this.write = tmp; }
        });

        this.velocityFBO = createDoubleRenderTarget();
        this.pressureFBO = createDoubleRenderTarget();
        this.divergenceFBO = createRenderTarget();

        this.simCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this.simScene = new THREE.Scene();
        this.simPlane = new THREE.PlaneGeometry(2, 2);
        this.targetMesh = new THREE.Mesh(this.simPlane, new THREE.MeshBasicMaterial());
        this.simScene.add(this.targetMesh);

        this.setupShaders();
        this.setupMainPlane();

        this.container.addEventListener('mousemove', this.boundOnMouseMove);
        window.addEventListener('resize', this.boundOnResize);

        this.clock = new THREE.Clock();
        this.state.isRunning = true;
        this.boundAnimate();
    }

    compileShader(fsShader, uniforms) {
        return new THREE.ShaderMaterial({
            vertexShader: `
                varying vec2 vUv;
                void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
            `,
            fragmentShader: fsShader,
            uniforms: uniforms,
            depthWrite: false, depthTest: false
        });
    }

    setupShaders() {
        this.advectShader = this.compileShader(`
            precision highp float;
            varying vec2 vUv;
            uniform sampler2D uVelocity;
            uniform float dt;
            uniform float dissipation;
            uniform vec2 texelSize;
            void main() {
                vec2 fboSize = 1.0 / texelSize;
                vec2 ratio = max(fboSize.x, fboSize.y) / fboSize;
                
                vec2 spot_new = vUv;
                vec2 vel_old = texture2D(uVelocity, vUv).xy;
                
                vec2 spot_old = spot_new - vel_old * dt * ratio;
                vec2 vel_new1 = texture2D(uVelocity, spot_old).xy;

                vec2 spot_new2 = spot_old + vel_new1 * dt * ratio;
                vec2 error = spot_new2 - spot_new;

                vec2 spot_new3 = spot_new - error / 2.0;
                vec2 vel_2 = texture2D(uVelocity, spot_new3).xy;

                vec2 spot_old2 = spot_new3 - vel_2 * dt * ratio;
                vec2 newVel2 = texture2D(uVelocity, spot_old2).xy * dissipation; 
                gl_FragColor = vec4(newVel2, 0.0, 1.0);
            }
        `, { uVelocity: { value: null }, dt: { value: this.options.dt }, dissipation: { value: this.options.dissipation }, texelSize: { value: new THREE.Vector2(1.0 / this.simResX, 1.0 / this.simResY) } });

        this.splatShader = this.compileShader(`
            precision highp float;
            varying vec2 vUv;
            uniform sampler2D uTarget;
            uniform vec2 point;
            uniform vec3 color;
            uniform float radius;
            uniform float aspectRatio;
            void main() {
                vec2 p = vUv - point;
                p.y /= aspectRatio;
                p /= radius;
                float d = 1.0 - min(length(p), 1.0);
                d *= d;
                vec3 splat = color * d;
                vec3 base = texture2D(uTarget, vUv).xyz;
                gl_FragColor = vec4(base + splat, 1.0);
            }
        `, { uTarget: { value: null }, point: { value: new THREE.Vector2() }, color: { value: new THREE.Vector3() }, radius: { value: this.options.cursor_size / 220.0 }, aspectRatio: { value: this.container.clientWidth / this.container.clientHeight } });

        this.divergenceShader = this.compileShader(`
            precision highp float;
            varying vec2 vUv;
            uniform sampler2D uVelocity;
            uniform vec2 texelSize;
            uniform float dt;
            void main() {
                float x0 = texture2D(uVelocity, vUv - vec2(texelSize.x, 0.0)).x;
                float x1 = texture2D(uVelocity, vUv + vec2(texelSize.x, 0.0)).x;
                float y0 = texture2D(uVelocity, vUv - vec2(0.0, texelSize.y)).y;
                float y1 = texture2D(uVelocity, vUv + vec2(0.0, texelSize.y)).y;
                float divergence = (x1 - x0 + y1 - y0) / 2.0;
                gl_FragColor = vec4(divergence / dt, 0.0, 0.0, 1.0);
            }
        `, { uVelocity: { value: null }, texelSize: { value: this.domainScale }, dt: { value: this.options.dt } });

        this.pressureShader = this.compileShader(`
            precision highp float;
            varying vec2 vUv;
            uniform sampler2D uPressure;
            uniform sampler2D uDivergence;
            uniform vec2 texelSize;
            void main() {
                float p0 = texture2D(uPressure, vUv + vec2(texelSize.x * 2.0, 0.0)).x;
                float p1 = texture2D(uPressure, vUv - vec2(texelSize.x * 2.0, 0.0)).x;
                float p2 = texture2D(uPressure, vUv + vec2(0.0, texelSize.y * 2.0)).x;
                float p3 = texture2D(uPressure, vUv - vec2(0.0, texelSize.y * 2.0)).x;
                float div = texture2D(uDivergence, vUv).x;
                float newP = (p0 + p1 + p2 + p3) / 5.0 - div;
                gl_FragColor = vec4(newP, 0.0, 0.0, 1.0);
            }
        `, { uPressure: { value: null }, uDivergence: { value: null }, texelSize: { value: this.domainScale } });

        this.gradientSubtractShader = this.compileShader(`
            precision highp float;
            varying vec2 vUv;
            uniform sampler2D uPressure;
            uniform sampler2D uVelocity;
            uniform vec2 texelSize;
            uniform float dt;
            void main() {
                float p0 = texture2D(uPressure, vUv + vec2(texelSize.x, 0.0)).x;
                float p1 = texture2D(uPressure, vUv - vec2(texelSize.x, 0.0)).x;
                float p2 = texture2D(uPressure, vUv + vec2(0.0, texelSize.y)).x;
                float p3 = texture2D(uPressure, vUv - vec2(0.0, texelSize.y)).x;
                vec2 v = texture2D(uVelocity, vUv).xy;
                vec2 gradP = vec2(p0 - p1, p2 - p3) * 0.5;
                v = v - gradP * dt;
                gl_FragColor = vec4(v, 0.0, 1.0);
            }
        `, { uPressure: { value: null }, uVelocity: { value: null }, texelSize: { value: this.domainScale }, dt: { value: this.options.dt } });
    }

    getCoverScale(textureAspect, planeAspect) {
        if (textureAspect > planeAspect) return new THREE.Vector2(planeAspect / textureAspect, 1.0);
        return new THREE.Vector2(1.0, textureAspect / planeAspect);
    }

    setupMainPlane() {
        this.targetAspect = this.container.clientWidth / this.container.clientHeight;

        this.mainUniforms = {
            tBase: { value: null },
            tOverlay: { value: null },
            tVelocity: { value: this.velocityFBO.read.texture },
            uScaleBase: { value: new THREE.Vector2(1, 1) },
            uScaleOverlay: { value: new THREE.Vector2(1, 1) }
        };

        const textureLoader = new THREE.TextureLoader();
        textureLoader.load(this.baseTextureUrl, tex => {
            this.mainUniforms.tBase.value = tex;
            this.mainUniforms.uScaleBase.value = this.getCoverScale(tex.image.width / tex.image.height, this.targetAspect);
        });
        textureLoader.load(this.overlayTextureUrl, tex => {
            this.mainUniforms.tOverlay.value = tex;
            this.mainUniforms.uScaleOverlay.value = this.getCoverScale(tex.image.width / tex.image.height, this.targetAspect);
        });

        const fragmentShaderRender = `
            uniform sampler2D tBase;
            uniform sampler2D tOverlay;
            uniform sampler2D tVelocity;
            uniform vec2 uScaleBase;
            uniform vec2 uScaleOverlay;
            varying vec2 vUv;
            
            vec2 getCoverUv(vec2 uv, vec2 scale) { return (uv - 0.5) * scale + 0.5; }
            
            void main() {
                vec2 uvBase = getCoverUv(vUv, uScaleBase);
                vec2 uvOverlay = getCoverUv(vUv, uScaleOverlay);
                
                vec4 faceColor = texture2D(tBase, uvBase);
                vec4 helmetColor = texture2D(tOverlay, uvOverlay);
                
                vec2 uvEffect = vec2(0.025 + vUv.x * 0.95, 0.025 + vUv.y * 0.95);
                vec2 vel = texture2D(tVelocity, uvEffect).xy;
                float len = length(vel);
                
                vec2 velNorm = vel * 0.5 + 0.5;
                vec3 colorTarget = vec3(velNorm.x, velNorm.y, 1.0);
                vec3 tNcolor = mix(vec3(1.0), colorTarget, len);
                
                vec3 textureCursorEffect = 1.0 - tNcolor;
                float cursorEffect = step(0.1, textureCursorEffect.r);
                
                gl_FragColor = mix(faceColor, helmetColor, cursorEffect);
            }
        `;

        const vertexShaderRender = `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                vec3 pos = position;
                pos.z += sin(pos.y * 5.0 + pos.x * 2.0) * 0.05; 
                gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
            }
        `;

        const mainMaterial = new THREE.ShaderMaterial({
            vertexShader: vertexShaderRender, fragmentShader: fragmentShaderRender, uniforms: this.mainUniforms, transparent: true
        });

        const fov = this.camera.fov * (Math.PI / 180);
        this.planeHeight = 2 * Math.tan(fov / 2) * this.camera.position.z;
        this.planeWidth = this.planeHeight * this.targetAspect;
        const mainGeometry = new THREE.PlaneGeometry(this.planeWidth * 1.5, this.planeHeight * 1.5, 32, 32);
        this.mainPlane = new THREE.Mesh(mainGeometry, mainMaterial);
        this.scene.add(this.mainPlane);
    }

    onMouseMove(e) {
        const rect = this.container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        this.state.isMoving = true;
        clearTimeout(this.state.moveTimeout);
        this.state.moveTimeout = setTimeout(() => { this.state.isMoving = false; }, 2000);

        let dx = e.movementX;
        let dy = e.movementY;

        if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) {
            let forceX = (dx / this.container.clientWidth) * this.options.mouse_force;
            let forceY = (-dy / this.container.clientHeight) * this.options.mouse_force;
            this.state.splats.push({
                x: mouseX / this.container.clientWidth,
                y: 1.0 - mouseY / this.container.clientHeight,
                dx: forceX,
                dy: forceY
            });
        }
        
        this.state.pointers[0] = {
            x: (mouseX / this.container.clientWidth) * 2 - 1,
            y: -(mouseY / this.container.clientHeight) * 2 + 1
        };
        this.state.lastMouseCoords.set(this.state.pointers[0].x, this.state.pointers[0].y);
    }

    onResize() {
        this.camera.aspect = this.container.clientWidth / this.container.clientHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
        
        this.targetAspect = this.container.clientWidth / this.container.clientHeight;
        
        if (this.mainUniforms.tBase.value) {
            this.mainUniforms.uScaleBase.value = this.getCoverScale(this.mainUniforms.tBase.value.image.width / this.mainUniforms.tBase.value.image.height, this.targetAspect);
        }
        if (this.mainUniforms.tOverlay.value) {
            this.mainUniforms.uScaleOverlay.value = this.getCoverScale(this.mainUniforms.tOverlay.value.image.width / this.mainUniforms.tOverlay.value.image.height, this.targetAspect);
        }
        
        this.mainPlane.scale.set((this.planeHeight * this.targetAspect) / this.planeWidth, 1, 1);
        this.splatShader.uniforms.aspectRatio.value = this.targetAspect;
    }

    renderSim(material, output) {
        this.targetMesh.material = material;
        this.renderer.setRenderTarget(output);
        this.renderer.render(this.simScene, this.simCamera);
        this.renderer.setRenderTarget(null);
    }

    stepFluidSim() {
        for (let i = 0; i < this.state.splats.length; i++) {
            const sp = this.state.splats[i];
            this.splatShader.uniforms.uTarget.value = this.velocityFBO.read.texture;
            this.splatShader.uniforms.point.value.set(sp.x, sp.y);
            this.splatShader.uniforms.color.value.set(sp.dx, sp.dy, 0.0);
            this.renderSim(this.splatShader, this.velocityFBO.write);
            this.velocityFBO.swap();
        }
        this.state.splats = [];

        this.advectShader.uniforms.uVelocity.value = this.velocityFBO.read.texture;
        if (this.advectShader.uniforms.texelSize) {
            this.advectShader.uniforms.texelSize.value.set(1.0 / this.simResX, 1.0 / this.simResY);
        }
        this.renderSim(this.advectShader, this.velocityFBO.write);
        this.velocityFBO.swap();

        this.divergenceShader.uniforms.uVelocity.value = this.velocityFBO.read.texture;
        this.renderSim(this.divergenceShader, this.divergenceFBO);

        this.pressureShader.uniforms.uDivergence.value = this.divergenceFBO.texture;
        for (let i = 0; i < this.options.iterations; i++) {
            this.pressureShader.uniforms.uPressure.value = this.pressureFBO.read.texture;
            this.renderSim(this.pressureShader, this.pressureFBO.write);
            this.pressureFBO.swap();
        }

        this.gradientSubtractShader.uniforms.uPressure.value = this.pressureFBO.read.texture;
        this.gradientSubtractShader.uniforms.uVelocity.value = this.velocityFBO.read.texture;
        this.renderSim(this.gradientSubtractShader, this.velocityFBO.write);
        this.velocityFBO.swap();
    }

    getEaseInOutQuad(t) {
        return t < 0.5 ? 2.0 * t * t : -1.0 + (4.0 - 2.0 * t) * t;
    }

    animate() {
        if (!this.state.isRunning) return;
        requestAnimationFrame(this.boundAnimate);

        let dt = this.clock.getDelta();

        if (!this.state.isMoving) {
            this.state.idleElapsed = (this.state.idleElapsed + dt) % this.CYCLE_TIME;
            let progX = 0, progY = 0;

            if (this.state.idleElapsed <= 2.5) {
                let t = this.state.idleElapsed / 2.5;
                progX = this.getEaseInOutQuad(t);
                progY = t;
            } else if (this.state.idleElapsed <= 4.0) {
                progX = 1.0;
                progY = 1.0;
            } else if (this.state.idleElapsed <= 6.5) {
                let t = (this.state.idleElapsed - 4.0) / 2.5;
                progX = 1.0 - this.getEaseInOutQuad(t);
                progY = 1.0 - t;
            } else {
                progX = 0.0;
                progY = 0.0;
            }

            let nextX = -Math.cos(progX * Math.PI * 4.0) * 0.75;
            let nextY = Math.cos(progY * Math.PI) * 0.5;

            let diffX = nextX - this.state.prevIdleCursor.x;
            let diffY = nextY - this.state.prevIdleCursor.y;

            if (Math.abs(diffX) > 0.0001 || Math.abs(diffY) > 0.0001) {
                let forceX = (diffX / 2.0) * this.options.mouse_force;
                let forceY = (diffY / 2.0) * this.options.mouse_force;
                this.state.splats.push({
                    x: nextX * 0.5 + 0.5,
                    y: nextY * 0.5 + 0.5,
                    dx: forceX,
                    dy: forceY
                });
            }

            this.state.pointers[0] = { x: nextX, y: nextY };
            this.state.prevIdleCursor.set(nextX, nextY);
        } else {
            this.state.prevIdleCursor.copy(this.state.lastMouseCoords);
        }

        this.state.simDelta += dt;
        if (this.state.simDelta >= this.state.simInterval) {
            this.stepFluidSim();
            this.state.simDelta = this.state.simDelta % this.state.simInterval;
        }

        if (this.state.pointers.length > 0 && this.state.pointers[0]) {
            this.state.targetParallaxX += (this.state.pointers[0].x * 0.12 - this.state.targetParallaxX) * 0.05;
            this.state.targetParallaxY += (this.state.pointers[0].y * 0.12 - this.state.targetParallaxY) * 0.05;
        }
        
        this.mainPlane.rotation.y = this.state.targetParallaxX;
        this.mainPlane.rotation.x = -this.state.targetParallaxY;

        this.mainUniforms.tVelocity.value = this.velocityFBO.read.texture;
        this.renderer.render(this.scene, this.camera);
    }

    destroy() {
        this.state.isRunning = false;
        this.container.removeEventListener('mousemove', this.boundOnMouseMove);
        window.removeEventListener('resize', this.boundOnResize);
        if (this.state.moveTimeout) clearTimeout(this.state.moveTimeout);
        this.renderer.dispose();
        this.container.innerHTML = '';
        
        // Target specifically disposed resources
        this.velocityFBO.read.dispose();
        this.velocityFBO.write.dispose();
        this.pressureFBO.read.dispose();
        this.pressureFBO.write.dispose();
        this.divergenceFBO.dispose();
    }
}
