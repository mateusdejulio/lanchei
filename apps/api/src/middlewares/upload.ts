// Upload de arquivos (multipart/form-data) com o multer, SEMPRE em memória:
// o disco do Render é temporário e nada que chega aqui precisa virar arquivo.
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import { ErroApi, erros } from '../erros.js';
import { MAX_ENTRADA_FOTO } from '../infra/fotos.js';

const TIPOS_FOTO = ['image/jpeg', 'image/png', 'image/webp'];
const TIPOS_CSV = ['text/csv', 'text/plain', 'application/vnd.ms-excel', 'application/csv', 'application/octet-stream'];

function criar(campo: string, maxBytes: number, tipos: string[], mensagemTipo: string): RequestHandler {
  const m = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 5 },
    fileFilter: (_req, arquivo, cb) => {
      // O tipo declarado pode mentir; é só uma primeira barreira.
      // A barreira de verdade é o processamento (sharp / leitura do CSV).
      if (tipos.includes(arquivo.mimetype)) cb(null, true);
      else cb(erros.regra('TIPO_DE_ARQUIVO', mensagemTipo));
    },
  }).single(campo);

  // Traduz os erros do multer para o formato de erro da API.
  return (req: Request, res: Response, next: NextFunction) => {
    m(req, res, (err: unknown) => {
      if (!err) {
        if (!req.file) return next(erros.regra('ARQUIVO_OBRIGATORIO', `Envie o arquivo no campo "${campo}".`));
        return next();
      }
      if (err instanceof ErroApi) return next(err);
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(new ErroApi(413, 'MUITO_GRANDE', `Arquivo maior que ${Math.round(maxBytes / 1024 / 1024)} MB.`));
        }
        return next(erros.regra('UPLOAD_INVALIDO', `Envio inválido: use um único arquivo no campo "${campo}".`));
      }
      next(err);
    });
  };
}

export const uploadFoto = criar('foto', MAX_ENTRADA_FOTO, TIPOS_FOTO, 'Envie uma foto JPEG, PNG ou WebP.');
export const uploadCsv = criar('arquivo', 2 * 1024 * 1024, TIPOS_CSV, 'Envie a planilha em CSV (modelo do Lanchei).');
