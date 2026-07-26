export async function compressImage(file: File, maxSide = 1200, quality = 0.82) {
  const image = new Image();
  const url = URL.createObjectURL(file);

  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = reject;
      image.src = url;
    });

    const ratio = Math.min(1, maxSide / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * ratio));
    canvas.height = Math.max(1, Math.round(image.height * ratio));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Не удалось обработать фото');

    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function createImageVariants(file: File) {
  const [photo, thumbnail] = await Promise.all([
    compressImage(file, 1400, 0.84),
    compressImage(file, 360, 0.76)
  ]);
  return { photo, thumbnail };
}

export function thumbnailUrl(photo: string) {
  return photo.replace(/-original(\.[a-z0-9]+)$/i, '-thumb$1');
}
