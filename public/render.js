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
