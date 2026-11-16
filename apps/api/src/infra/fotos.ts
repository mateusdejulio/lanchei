// Fotos dos alunos: normalização com o sharp e resposta HTTP.
//
// Toda foto que entra é REPROCESSADA: gira conforme a orientação da câmera,
// recorta em 400x400 e vira JPEG de novo. Isso:
//   - remove os metadados (EXIF), inclusive a localização GPS em que a foto
//     foi tirada (o sharp só preserva metadados se pedirmos);
//   - descarta qualquer coisa "escondida" no arquivo original;
//   - deixa todas as fotos com o mesmo tamanho (~30-60 KB) no banco.
import type { Response } from 'express';
import sharp from 'sharp';
import { sha256 } from './cripto.js';
import { erros } from '../erros.js';

export const LADO_FOTO = 400;
export const MAX_ENTRADA_FOTO = 5 * 1024 * 1024; // 5 MB (etapa3)

export interface FotoProcessada {
  conteudo: Buffer;
  sha256: Buffer;
}

export async function processarFoto(entrada: Buffer): Promise<FotoProcessada> {
  try {
    const conteudo = await sharp(entrada, {
      // Proteção contra "bomba de descompressão": um arquivo pequeno que
      // declara 100 mil x 100 mil pixels e estoura a memória ao abrir.
      limitInputPixels: 60_000_000, // ~ câmera de 60 MP
      failOn: 'error',
    })
      .rotate() // aplica a orientação do EXIF antes de descartá-lo
      .resize(LADO_FOTO, LADO_FOTO, { fit: 'cover', position: 'attention' }) // recorta mirando o rosto/centro de interesse
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();
    return { conteudo, sha256: sha256(conteudo) };
  } catch {
    throw erros.regra('IMAGEM_INVALIDA', 'Não foi possível ler a imagem. Envie uma foto JPEG, PNG ou WebP.');
  }
}

/** Responde os bytes da foto sem deixar cópia em cache (dados de menores). */
export function responderFoto(res: Response, foto: { conteudo: Buffer; mime_type: string; sha256: Buffer }) {
  res
    .status(200)
    .set({
      'Content-Type': foto.mime_type,
      'Cache-Control': 'private, no-store',
      ETag: `"${foto.sha256.toString('hex')}"`,
    })
    .send(foto.conteudo);
}
