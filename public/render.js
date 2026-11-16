export function smooth(context) {
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  return context;
}

// Supersample ordinary covers, while keeping large exports within a pixel budget.
export function renderDimensions(width, height) {
  const scale = Math.max(1, Math.min(2, Math.sqrt(16_000_000 / (width * height))));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export function previewDimensions(cssWidth, width, height, pixelRatio = 1) {
  const requestedWidth = Math.max(1, cssWidth) * Math.max(1, pixelRatio);
  const scale = Math.min(1, Math.sqrt(4_000_000 / (requestedWidth * requestedWidth * height / width)));
  const pixels = Math.max(1, Math.round(requestedWidth * scale));
  return { width: pixels, height: Math.max(1, Math.round(pixels * height / width)) };
}

export function fitCanvasSize(availableWidth, availableHeight, width, height) {
  const scale = Math.min(Math.max(1, availableWidth) / width, Math.max(1, availableHeight) / height);
  return { width: width * scale, height: height * scale };
}

export function createFrameScheduler(render, request = callback => requestAnimationFrame(callback), cancel = handle => cancelAnimationFrame(handle)) {
  let pending = null;
  return {
    schedule() {
      if (pending !== null) return;
      pending = request(() => { pending = null; render(); });
    },
    cancel() { if (pending !== null) cancel(pending); pending = null; },
  };
}

// During a transform only the selected instance changes. Cache the layers on
// either side of it, so shadows for the rest of the composition are drawn once.
export function createTransformLayers(createSurface = () => document.createElement('canvas')) {
  let lower, upper, cachedKey;
  return {
    render({ context, frames, images, settings, selected, width, height, revision, drawPhoto }) {
      const index = frames.findIndex(frame => frame.instanceId === selected);
      if (index < 0 || !images.has(frames[index].id)) return false;
      const key = `${revision}:${selected}:${width}:${height}`;
      const scale = width / settings.width;
      if (cachedKey !== key) {
        lower ||= createSurface(); upper ||= createSurface();
        for (const [surface, start, end, background] of [[lower, 0, index, true], [upper, index + 1, frames.length, false]]) {
          surface.width = width; surface.height = height;
          const layer = smooth(surface.getContext('2d'));
          layer.setTransform(scale, 0, 0, height / settings.height, 0, 0);
          if (background) { layer.fillStyle = settings.background; layer.fillRect(0, 0, settings.width, settings.height); }
          for (let i = start; i < end; i++) {
            const image = images.get(frames[i].id);
            if (image) drawPhoto(layer, frames[i], image, settings, scale);
          }
        }
        cachedKey = key;
      }
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, width, height);
      context.drawImage(lower, 0, 0);
      context.save();
      context.setTransform(scale, 0, 0, height / settings.height, 0, 0);
      drawPhoto(context, frames[index], images.get(frames[index].id), settings, scale);
      context.restore();
      context.drawImage(upper, 0, 0);
      return true;
    },
    invalidate() {
      cachedKey = null;
      if (lower) lower.width = lower.height = 0;
      if (upper) upper.width = upper.height = 0;
    },
  };
}

export function createPhotoRenderer() {
  const mipmaps = new WeakMap();
  function sample(image, targetWidth, targetHeight) {
    let levels = mipmaps.get(image);
    if (!levels) { levels = [image]; mipmaps.set(image, levels); }
    let level = 0, source = image;
    // Avoid minifying fine details by a large factor in a single rotated draw.
    while (source.width > Math.max(1, targetWidth) * 2 || source.height > Math.max(1, targetHeight) * 2) {
      if (!levels[level + 1]) {
        const next = document.createElement('canvas');
        next.width = Math.max(1, Math.ceil(source.width / 2));
        next.height = Math.max(1, Math.ceil(source.height / 2));
        smooth(next.getContext('2d')).drawImage(source, 0, 0, next.width, next.height);
        levels.push(next);
      }
      source = levels[++level];
    }
    return source;
  }
  return {
    draw(context, item, image, settings, pixelScale = 1) {
      const height = item.width * image.height / image.width;
      const filtered = sample(image, item.width * pixelScale, height * pixelScale);
      context.save(); smooth(context);
      context.translate(item.x, item.y); context.rotate(item.angle * Math.PI / 180);
      context.shadowColor = '#15200d42';
      // Canvas shadows do not follow the context's scale transform.
      context.shadowBlur = settings.shadow * pixelScale;
      context.shadowOffsetY = settings.shadow * .3 * pixelScale;
      context.fillStyle = '#fff';
      context.fillRect(-item.width / 2 - settings.border, -height / 2 - settings.border, item.width + settings.border * 2, height + settings.border * 2);
      context.shadowColor = 'transparent';
      context.drawImage(filtered, -item.width / 2, -height / 2, item.width, height);
      context.restore();
    },
    release(image) {
      for (const level of mipmaps.get(image)?.slice(1) || []) level.width = level.height = 0;
      mipmaps.delete(image);
    },
  };
}
