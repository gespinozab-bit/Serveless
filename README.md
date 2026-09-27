# Lambda: redimensionar imágenes de S3

Node.js 22.x, TypeScript, npm, AWS SDK v3 y sharp; sin frameworks.

## Compilar

Con Node.js 22 y npm 10 o posterior:

```sh
npm install
npm run build
```

Ejecuta `npm test` para verificar el procesamiento con sharp real y S3 simulado,
sin credenciales ni acceso a AWS.

El build verifica los tipos y genera `dist/index.js` en CommonJS. Incluye el SDK
de S3 y deja `sharp` como dependencia externa. Para instalaciones reproducibles
posteriores, usa `npm ci` con el `package-lock.json` incluido.

## Preparar el ZIP (PowerShell)

Desde la raíz del proyecto, después del build, usa una carpeta `package` nueva:

```powershell
New-Item -ItemType Directory -Path package
Copy-Item dist/index.js package/index.js
$sharpVersion = node -p "require('./node_modules/sharp/package.json').version"
npm install --prefix package --os=linux --cpu=x64 --libc=glibc --include=optional --omit=dev "sharp@$sharpVersion"
Compress-Archive -Path package/* -DestinationPath lambda.zip -Force
```

El ZIP debe tener `index.js`, `package.json` y `node_modules/` directamente en
su raíz. Los binarios de sharp deben ser de Linux aunque compiles en Windows.
Estos comandos preparan **x86_64**; para una Lambda **arm64**, sustituye
`--cpu=x64` por `--cpu=arm64` y utiliza una carpeta de empaquetado nueva.

## Configurar en la consola AWS

1. Crea una función con runtime **Node.js 22.x**, arquitectura **x86_64** y
   handler **index.handler**. Sube `lambda.zip`.
2. Configura opcionalmente `WIDTH=1280` y `HEIGHT=720`. Si faltan o están vacías,
   se usan esos valores. Los valores configurados deben ser enteros positivos.
3. Como punto de partida, asigna 512 MB de memoria y 30 segundos de timeout;
   ajústalos al tamaño y cantidad de imágenes.
4. El rol de ejecución necesita permisos de logs (`AWSLambdaBasicExecutionRole`)
   y esta política, reemplazando `TU_BUCKET` en ambos recursos:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::TU_BUCKET/originals/*"
    },
    {
      "Effect": "Allow",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::TU_BUCKET/resized/*"
    }
  ]
}
```

5. Agrega un trigger S3 para ese mismo bucket, en la misma región, con eventos
   **All object create events** (`s3:ObjectCreated:*`) y filtro de prefijo
   **originals/**. La consola configura el permiso de invocación de S3.
   El filtro evita que las salidas vuelvan a disparar la función.

No se incluyen credenciales: el SDK utiliza el rol de ejecución de Lambda.

## Comportamiento y prueba

Sube `originals/foto.jpg` y `originals/foto.png`. Deben aparecer
`resized/foto-resized.jpg` y `resized/foto-resized.png`, con dimensiones exactas
1280 × 720 y sus Content-Type `image/jpeg` e `image/png`. Se respeta la proporción
y se recorta al centro; el original permanece intacto. También admite `.jpeg`,
extensiones en mayúsculas, subcarpetas, espacios y caracteres codificados por S3.

Se ignoran otros prefijos, eventos y extensiones. Cada Record se intenta procesar;
los errores se registran y al terminar se lanza un error conjunto para permitir
reintentos. Los eventos repetidos escriben en la misma clave de salida (si el
bucket tiene versionado, S3 puede conservar versiones de esa misma clave).
Los logs de CloudWatch incluyen bucket, entrada, salida, WIDTH, HEIGHT y éxito.

Referencias: [evento S3 y decodificación del key](https://docs.aws.amazon.com/lambda/latest/dg/with-s3-example.html),
[sharp en Lambda y empaquetado para Linux](https://sharp.pixelplumbing.com/install/),
[redimensionamiento con cover](https://sharp.pixelplumbing.com/api-resize/).
