'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';

const SEPARATION = 150;
const AMOUNT_X = 40;
const AMOUNT_Y = 60;
// Phase drift per second. Time-based (not per-frame) so the wave moves at the
// same speed on 60Hz and 120Hz displays. Lower = calmer. Was ~6/s (0.1/frame
// at 60fps) which read as too fast; 1.5/s is a smooth, slow drift.
const PHASE_SPEED = 1.5;

/**
 * Cheap WebGL capability probe. A browser without a usable WebGL context
 * (GPU/driver blocked, headless, per-page context limit reached) returns null
 * from getContext; checking up front lets us skip the Three.js renderer
 * entirely instead of letting its constructor log an error and throw.
 */
function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

/**
 * The Three.js scene that owns the animated dot grid. Lives inside an
 * absolute layer behind the hero content. Listens for container resize so
 * the surface always matches its parent without cutoff, and pauses the
 * animation loop when prefers-reduced-motion is set.
 */
export function DottedSurfaceCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    // Degrade gracefully when WebGL isn't available (GPU/driver blocked,
    // headless, context limit): skip the animated backdrop entirely. The parent
    // still renders the gradient + hero content, and nothing is logged or
    // thrown — this is what prevents the "Error creating WebGL context" reports.
    if (!isWebGLAvailable()) return;

    // Scene + camera + renderer
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0a0a0d, 2000, 10000);

    const camera = new THREE.PerspectiveCamera(60, width / height, 1, 10000);
    camera.position.set(0, 355, 1220);

    // Backstop: even when the probe above passes, renderer creation can still
    // fail (a context-loss race, or the context limit hit between the probe and
    // here). Catch it and degrade the same way instead of surfacing an error.
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    } catch (err) {
      console.warn(
        '[dotted-surface] WebGL context creation failed — skipping animated backdrop',
        err,
      );
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    // Dot grid geometry
    const geometry = new THREE.BufferGeometry();
    const positions: number[] = [];
    const colors: number[] = [];

    for (let ix = 0; ix < AMOUNT_X; ix++) {
      for (let iy = 0; iy < AMOUNT_Y; iy++) {
        const x = ix * SEPARATION - (AMOUNT_X * SEPARATION) / 2;
        const z = iy * SEPARATION - (AMOUNT_Y * SEPARATION) / 2;
        positions.push(x, 0, z);
        // Light-gray dots — D3 stays in white/yellow palette, neutral here.
        colors.push(200 / 255, 200 / 255, 200 / 255);
      }
    }

    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(positions, 3),
    );
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: 8,
      vertexColors: true,
      transparent: true,
      opacity: 0.8,
      sizeAttenuation: true,
    });

    const points = new THREE.Points(geometry, material);
    scene.add(points);

    // Reduced-motion check — render once and skip the loop.
    const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reducedMotion = reducedMotionQuery.matches;

    let animationId = 0;
    let count = 0;
    let lastTime = 0;

    const positionAttribute = geometry.attributes.position;
    const positionArray = positionAttribute.array as Float32Array;

    const tickPositions = () => {
      let i = 0;
      for (let ix = 0; ix < AMOUNT_X; ix++) {
        for (let iy = 0; iy < AMOUNT_Y; iy++) {
          positionArray[i * 3 + 1] =
            Math.sin((ix + count) * 0.3) * 50 +
            Math.sin((iy + count) * 0.5) * 50;
          i++;
        }
      }
      positionAttribute.needsUpdate = true;
    };

    const renderOnce = () => {
      tickPositions();
      renderer.render(scene, camera);
    };

    const animate = (now = performance.now()) => {
      animationId = requestAnimationFrame(animate);
      if (lastTime === 0) lastTime = now;
      // Clamp dt so returning from a backgrounded tab doesn't jump the phase.
      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;
      count += PHASE_SPEED * dt;
      tickPositions();
      renderer.render(scene, camera);
    };

    const start = () => {
      if (reducedMotion) {
        renderOnce();
      } else {
        animate();
      }
    };

    const stop = () => {
      if (animationId) cancelAnimationFrame(animationId);
      animationId = 0;
    };

    const handleMotionChange = (e: MediaQueryListEvent) => {
      reducedMotion = e.matches;
      stop();
      start();
    };
    reducedMotionQuery.addEventListener('change', handleMotionChange);

    // ResizeObserver so the dot surface always fits its container — no cutoff
    // when the layout grows.
    const handleResize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      if (reducedMotion) renderOnce();
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(container);

    start();

    return () => {
      stop();
      reducedMotionQuery.removeEventListener('change', handleMotionChange);
      resizeObserver.disconnect();
      scene.traverse((object) => {
        if (object instanceof THREE.Points) {
          object.geometry.dispose();
          if (Array.isArray(object.material)) {
            object.material.forEach((m) => m.dispose());
          } else {
            object.material.dispose();
          }
        }
      });
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10"
    />
  );
}
