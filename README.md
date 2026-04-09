# Lando-Effect 🏁

A 100% mathematically accurate, standalone vanilla JavaScript replication of the WebGL Navier-Stokes fluid masking effect originally seen on the award-winning Lando Norris portfolio.

This library extracts the deeply-nested WebGL FBO simulations, custom Navier-Stokes physics solvers, BFECC advection calculations, and compositing shaders into a single, clean ES6 Class module. It runs purely on Three.js (via CDN) with zero frontend build tools or framework dependencies required.

## Features
- **Perfect Parity:** Flawlessly replicates the original site's physical parameters natively, including the 60fps fractional framelimiter, 5-Poisson pressure solver, and bounded texel resolution locking.
- **GSAP-less Idle Simulation:** Includes a mathematically derived "Figure-8" idle cursor timeline that triggers automatically, ensuring permanent gooey movement when the user rests their mouse.
- **Resolution Agnostic:** The internal coordinate algebra dynamically ties splat geometry to normalized device coordinate spans (`[-1, 1]`), ensuring smooth boundaries free of artifacts at any screen ratio or viewport size.
- **Memory Safe:** Contains a native `.destroy()` teardown sequence that safely purges all `WebGLRenderTargets` and events from memory when unmounting in modern SPAs (React, Vue, Svelte).

## Installation

Download the `fluid-reveal.js` module and place it into your project folder. Ensure you are importing it within an environment that supports ES6 syntax (`<script type="module">`).

## Usage

Create a container element with an explicit width and height. The simulation dynamically binds its domain to the physical pixel density of this box.

```html
<div id="fluid-container" style="width: 100vw; height: 100vh;"></div>

<script type="module">
    import FluidReveal from './fluid-reveal.js';

    // Initialize after the DOM container resolves its layout dimensions
    document.addEventListener('DOMContentLoaded', () => {
        const myReveal = new FluidReveal({
            container: document.getElementById('fluid-container'),
            baseTextureUrl: 'path/to/background.jpg',
            overlayTextureUrl: 'path/to/revealed-helmet.jpg'
        });
    });
</script>
```

### Configuration Options

You can override the internal physics constants by passing an `options` object into the constructor. The default values listed below represent the exact constants used by the original production engineers.

```javascript
const myReveal = new FluidReveal({
    container: document.getElementById('fluid-container'),
    baseTextureUrl: 'path/to/background.jpg',
    overlayTextureUrl: 'path/to/overlay.jpg',
    options: {
        cursor_size: 18,    // Scale boundary of the fluid injection splats
        mouse_force: 50,    // Inertial velocity power behind user drag movements
        resolution: 0.1,    // FBO down-sampling scale for the structural "gooey" aesthetic (10% of screen)
        dissipation: 0.96,  // Velocity frame-over-frame decay rate
        dt: 0.014,          // Frame delta constraint
        iterations: 4       // Poisson pressure iterations (computational precision)
    }
});
```

### Teardown
If you are rapidly mounting and unmounting pages (like within a React `useEffect`), remember to kill the WebGL context memory to prevent memory leaks:
```javascript
myReveal.destroy();
```

## Credits
This project was born out of a desire to understand exactly how the top-tier Awwwards-winning WebGL interfaces operate under the hood. 

Math doesn't lie, but reversing minified min-max matrices takes a village. The reverse-engineering, exact algebraic translation, and extraction into this standalone component was accomplished with the assistance of advanced AI.

Inspired deeply by the beautiful engineering over at the [Off-Brand agency](https://www.itsoffbrand.com/).
