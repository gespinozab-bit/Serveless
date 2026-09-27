import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { S3Handler } from 'aws-lambda';
import sharp from 'sharp';

// Lambda obtiene las credenciales de su rol de ejecución.
const s3 = new S3Client({});
const inputPrefix = 'originals/';

function dimension(name: 'WIDTH' | 'HEIGHT', fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} debe ser un entero positivo; recibido: ${raw}`);
  }
  return value;
}

export const handler: S3Handler = async (event) => {
  let width: number;
  let height: number;
  try {
    width = dimension('WIDTH', 1280);
    height = dimension('HEIGHT', 720);
  } catch (error) {
    console.error('Configuración de dimensiones inválida', error);
    throw error;
  }

  const errors: unknown[] = [];
  // Procesamiento secuencial para limitar la memoria usada por las imágenes.
  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    let inputKey = record.s3.object.key;
    let outputKey: string | undefined;
    try {
      inputKey = decodeURIComponent(inputKey.replace(/\+/g, ' '));
      if (!record.eventName.startsWith('ObjectCreated:') || !inputKey.startsWith(inputPrefix)) {
        console.log('Objeto ignorado', { bucket, inputKey });
        continue;
      }

      const relativeKey = inputKey.slice(inputPrefix.length);
      const extension = /\.(jpe?g|png)$/i.exec(relativeKey);
      if (!extension) {
        console.log('Formato no soportado; objeto ignorado', { bucket, inputKey });
        continue;
      }

      outputKey = `resized/${relativeKey.slice(0, -extension[0].length)}-resized${extension[0]}`;
      const format = extension[1].toLowerCase() === 'png' ? 'png' : 'jpeg';
      const contentType = format === 'png' ? 'image/png' : 'image/jpeg';

      const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: inputKey }));
      if (!object.Body) throw new Error('El objeto de S3 no contiene un cuerpo');

      const original = await object.Body.transformToByteArray();
      const resized = await sharp(original)
        .rotate() // Respeta la orientación EXIF antes de recortar.
        .resize(width, height, { fit: 'cover', position: 'centre' })
        .toFormat(format)
        .toBuffer();

      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: outputKey,
        Body: resized,
        ContentType: contentType,
      }));

      console.log('Imagen redimensionada exitosamente', {
        bucket, inputKey, outputKey, WIDTH: width, HEIGHT: height, result: 'success',
      });
    } catch (error) {
      console.error('Error al procesar imagen', {
        bucket, inputKey, outputKey, WIDTH: width, HEIGHT: height, error,
      });
      errors.push(error);
    }
  }

  // Intentar todos los Records y después señalar el fallo para permitir reintentos.
  if (errors.length > 0) {
    throw new AggregateError(errors, `Falló el procesamiento de ${errors.length} objeto(s)`);
  }
};
