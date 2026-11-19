// Agendador mínimo para os jobs (sem dependência extra).
//
// Cada job roda num intervalo fixo, com uma trava "rodando": se a execução
// anterior ainda não terminou (ex.: o Mercado Pago está lento), a próxima é
// pulada em vez de empilhar. Basta porque a API roda numa instância só no
// Render. Com mais de uma instância, cada job precisaria de um lock no banco
// (GET_LOCK do MySQL) para só uma executar (etapa3 §3).
import { logger } from '../infra/logger.js';

export interface Agendamento {
  nome: string;
  intervaloMs: number;
  /** Espera antes da 1ª execução (não sobrecarregar a subida da API). */
  atrasoInicialMs: number;
  tarefa: () => Promise<unknown>;
}

export function agendar(a: Agendamento): () => void {
  let rodando = false;
  const executar = async () => {
    if (rodando) return;
    rodando = true;
    const inicio = Date.now();
    try {
      const resultado = await a.tarefa();
      if (resultado !== undefined) logger.debug({ job: a.nome, ms: Date.now() - inicio, resultado }, 'job concluído');
    } catch (err) {
      // Um job com erro não derruba a API nem os outros jobs; tenta de novo no próximo ciclo.
      logger.error({ job: a.nome, err }, 'job falhou');
    } finally {
      rodando = false;
    }
  };
  const primeira = setTimeout(() => void executar(), a.atrasoInicialMs);
  const ciclo = setInterval(() => void executar(), a.intervaloMs);
  return () => {
    clearTimeout(primeira);
    clearInterval(ciclo);
  };
}
