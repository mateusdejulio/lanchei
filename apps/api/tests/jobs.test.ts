// Jobs: push (Web Push simulado), renovação do token do Mercado Pago,
// reconciliação e limpeza.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/infra/db.js';
import { criptografar, descriptografar } from '../src/infra/cripto.js';
import { aguardarEmailsPendentes, emailsPara } from '../src/infra/email.js';
import type { ConteudoPush, DestinoWebPush, EnviadorPush, ResultadoPush } from '../src/infra/push.js';
import type { ClienteOAuthMp } from '../src/infra/mercadopago.js';
import { enviarPushPendentes, urlDaNotificacao } from '../src/jobs/push.job.js';
import { renovarTokensMp } from '../src/jobs/mercadopago.jobs.js';
import { limpar, reconciliar } from '../src/jobs/manutencao.jobs.js';
import { realizarCompra } from '../src/modulos/caixa/compra.servico.js';
import { conectarMercadoPago, criarAluno, criarEscola, criarSuperadmin, novaChave, type Escola } from './fixtures.js';

afterAll(() => db.destroy());

let escola: Escola;
beforeEach(async () => {
  escola = await criarEscola();
});

describe('job de push', () => {
  /** Enviador falso: registra tudo e responde o que o teste mandar por endpoint. */
  function enviadorFalso(respostas: Record<string, ResultadoPush> = {}) {
    const enviados: { destino: DestinoWebPush; conteudo: ConteudoPush }[] = [];
    const e: EnviadorPush = {
      async enviar(destino, conteudo) {
        enviados.push({ destino, conteudo });
        return respostas[destino.endpoint] ?? { tipo: 'OK' };
      },
    };
    return { e, enviados };
  }
  const aparelho = async (responsavelId: number, sufixo: string) => {
    const endpoint = `https://push.exemplo.com/${sufixo}-${novaChave()}`;
    const { sha256 } = await import('../src/infra/cripto.js');
    const [id] = await db('dispositivos_push_lanchei').insert({
      responsavel_id: responsavelId, canal: 'WEB', identificador_hash: sha256(endpoint), web_endpoint: endpoint, web_p256dh: 'p'.repeat(20), web_auth: 'a'.repeat(20), plataforma: 'ANDROID',
    });
    return { id: id!, endpoint };
  };
  const comprar = (qr: string) =>
    realizarCompra({
      escolaId: escola.escolaId, operadorId: escola.operadorId, idempotencyKey: novaChave(),
      identificacao: { tipo: 'CARTEIRINHA', qrConteudo: qr }, itens: [{ produtoId: escola.produtos.suco, quantidade: 1 }],
    });

  beforeEach(async () => {
    // O banco de teste é compartilhado: o que outros testes deixaram na fila não entra aqui.
    await db('notificacoes_lanchei').whereNull('push_enviado_em').update({ push_enviado_em: new Date(), push_erro: 'TESTE' });
  });

  it('envia a compra para todos os aparelhos ativos de cada responsável, uma vez só', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 5000 });
    const [mae, pai] = a.responsavelIds as [number, number];
    const celular = await aparelho(mae, 'celular');
    const tablet = await aparelho(mae, 'tablet');
    await aparelho(pai, 'pai');
    const r = await comprar(a.qr);
    if (r.status !== 'CONFIRMADO') throw new Error('compra deveria passar');

    const { e, enviados } = enviadorFalso();
    const stats = await enviarPushPendentes(e);
    expect(stats).toMatchObject({ notificacoes: 2, enviadas: 2, semAparelho: 0, falhas: 0 });
    const destinos = enviados.map((x) => x.destino.endpoint);
    expect(destinos).toHaveLength(3);
    expect(destinos).toEqual(expect.arrayContaining([celular.endpoint, tablet.endpoint, expect.stringContaining('/pai-')]));
    expect(enviados[0]!.conteudo).toMatchObject({ titulo: 'Compra na cantina', url: `/app/filhos/${a.alunoId}/compras/${r.pedido.id}` });
    expect(enviados[0]!.conteudo.corpo).not.toMatch(/Silva/); // só o primeiro nome na tela bloqueada

    // Segunda rodada: nada de novo (sem duplicar).
    expect((await enviarPushPendentes(e)).notificacoes).toBe(0);
    expect(enviados).toHaveLength(3);
  });

  it('410 do serviço de push desativa o aparelho; sem aparelho e erro ficam registrados', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 5000 });
    const [mae, pai] = a.responsavelIds as [number, number];
    const velho = await aparelho(mae, 'desinstalado');
    // o pai não tem aparelho
    await comprar(a.qr);

    const { e } = enviadorFalso({ [velho.endpoint]: { tipo: 'EXPIRADO' } });
    const stats = await enviarPushPendentes(e);
    expect(stats).toMatchObject({ enviadas: 0, semAparelho: 1, falhas: 1, aparelhosDesativados: 1 });
    expect((await db('dispositivos_push_lanchei').where({ id: velho.id }).first()).ativo).toBe(false);
    const notifs = await db('notificacoes_lanchei').where({ aluno_id: a.alunoId, tipo: 'COMPRA' });
    expect(notifs.find((n) => n.responsavel_id === pai).push_erro).toBe('SEM_APARELHO');
    expect(notifs.find((n) => n.responsavel_id === mae).push_erro).toBe('EXPIRADO');
    expect(notifs.every((n) => n.push_enviado_em !== null)).toBe(true);
  });

  it('notificação com mais de 24 h não é enviada (perdeu o sentido)', async () => {
    const a = await criarAluno(escola, { saldoCentavos: 5000, responsaveis: 1 });
    await aparelho(a.responsavelIds[0]!, 'x');
    await comprar(a.qr);
    await db('notificacoes_lanchei').where({ aluno_id: a.alunoId }).update({ created_at: new Date(Date.now() - 25 * 3_600_000) });
    const { e, enviados } = enviadorFalso();
    await enviarPushPendentes(e);
    expect(enviados).toHaveLength(0);
    expect((await db('notificacoes_lanchei').where({ aluno_id: a.alunoId }).first()).push_erro).toBe('EXPIRADA');
  });

  it('URL de destino conforme os dados da notificação', () => {
    expect(urlDaNotificacao(7, { pedidoId: 9 })).toBe('/app/filhos/7/compras/9');
    expect(urlDaNotificacao(7, { depositoId: 3 })).toBe('/app/filhos/7/extrato');
    expect(urlDaNotificacao(7, null)).toBe('/app/filhos/7');
    expect(urlDaNotificacao(null, null)).toBe('/app/notificacoes');
  });
});

describe('renovação do token do Mercado Pago', () => {
  const DIA = 86_400_000;
  beforeEach(async () => {
    // Outras escolas do banco de teste não entram nesta rodada.
    await db('escola_mercadopago_lanchei').update({ token_expira_em: new Date(Date.now() + 200 * DIA) });
  });
  const oauthFalso = (mpUserId: string, falhar = false) => {
    const chamadas: string[] = [];
    const c: ClienteOAuthMp = {
      urlAutorizacao: () => '',
      trocarCodigo: async () => { throw new Error('não usado'); },
      renovar: async (refresh) => {
        chamadas.push(refresh);
        if (falhar) throw new Error('MP oauth/token falhou: HTTP 400');
        return { accessToken: 'APP_USR-novo', refreshToken: 'TG-refresh-novo', mpUserId, publicKey: null, expiraEm: new Date(Date.now() + 180 * DIA) };
      },
    };
    return { c, chamadas };
  };

  it('renova quem vence em menos de 30 dias e guarda o refresh NOVO (o antigo deixa de valer no MP)', async () => {
    const mpUserId = await conectarMercadoPago(escola.escolaId);
    await db('escola_mercadopago_lanchei').where({ escola_id: escola.escolaId }).update({ token_expira_em: new Date(Date.now() + 10 * DIA) });
    const { c, chamadas } = oauthFalso(mpUserId);

    expect(await renovarTokensMp(c)).toEqual({ renovados: 1, falhas: 0 });
    expect(chamadas).toEqual(['REFRESH-DA-CANTINA']);
    const l = await db('escola_mercadopago_lanchei').where({ escola_id: escola.escolaId }).first();
    expect(descriptografar(l.access_token_enc)).toBe('APP_USR-novo');
    expect(descriptografar(l.refresh_token_enc)).toBe('TG-refresh-novo');
    expect(l.token_expira_em.getTime()).toBeGreaterThan(Date.now() + 170 * DIA);
    expect(await db('auditoria_lanchei').where({ acao: 'MP_TOKEN_RENOVAR', escola_id: escola.escolaId }).first()).toBeTruthy();

    // Token longe de vencer: não renova de novo.
    expect(await renovarTokensMp(c)).toEqual({ renovados: 0, falhas: 0 });
  });

  it('falha no MP não apaga nada (a cantina vê o alerta e reconecta)', async () => {
    const mpUserId = await conectarMercadoPago(escola.escolaId);
    await db('escola_mercadopago_lanchei').where({ escola_id: escola.escolaId }).update({ token_expira_em: new Date(Date.now() + 10 * DIA) });
    expect(await renovarTokensMp(oauthFalso(mpUserId, true).c)).toEqual({ renovados: 0, falhas: 1 });
    expect(descriptografar((await db('escola_mercadopago_lanchei').where({ escola_id: escola.escolaId }).first()).refresh_token_enc)).toBe('REFRESH-DA-CANTINA');
  });

  it('se a cantina reconectou durante a renovação, a conexão nova NÃO é sobrescrita', async () => {
    const mpUserId = await conectarMercadoPago(escola.escolaId);
    await db('escola_mercadopago_lanchei').where({ escola_id: escola.escolaId }).update({ token_expira_em: new Date(Date.now() + 10 * DIA) });
    const { c } = oauthFalso(mpUserId);
    const lento: ClienteOAuthMp = {
      ...c,
      renovar: async (r) => {
        // Enquanto o MP responde, a cantina reconecta pelo painel:
        await db('escola_mercadopago_lanchei').where({ escola_id: escola.escolaId }).update({ refresh_token_enc: criptografar('TG-da-reconexao') });
        return c.renovar(r);
      },
    };
    expect(await renovarTokensMp(lento)).toEqual({ renovados: 0, falhas: 0 });
    expect(descriptografar((await db('escola_mercadopago_lanchei').where({ escola_id: escola.escolaId }).first()).refresh_token_enc)).toBe('TG-da-reconexao');
  });
});

describe('reconciliação e limpeza', () => {
  it('sem divergência não avisa ninguém; com divergência manda e-mail ao superadmin', async () => {
    const sa = await criarSuperadmin();
    expect(await reconciliar()).toMatchObject({ contasDivergentes: 0, estoqueDivergente: 0, alertados: 0 });

    const a = await criarAluno(escola, { saldoCentavos: 1000 });
    try {
      // Simula um bug: alguém mexeu no saldo sem passar pelo ledger.
      await db('contas_lanchei').where({ id: a.contaId }).update({ saldo_centavos: 999_999 });
      const r = await reconciliar();
      expect(r.contasDivergentes).toBe(1);
      await aguardarEmailsPendentes();
      const email = emailsPara(sa.email).at(-1)!;
      expect(email.assunto).toContain('divergência');
      expect(email.texto).not.toMatch(/João/); // só quantidades, nenhum dado pessoal
    } finally {
      await db('contas_lanchei').where({ id: a.contaId }).update({ saldo_centavos: 1000 });
    }
  });

  it('limpeza marca sessões e tokens de e-mail vencidos (sem DELETE)', async () => {
    const [sid] = await db('sessoes_lanchei').insert({ usuario_id: escola.adminId, token_hash: Buffer.alloc(32, Date.now() % 251), expira_em: new Date(Date.now() - 1000) });
    const r = await limpar();
    expect(r.sessoesExpiradas).toBeGreaterThanOrEqual(1);
    expect((await db('sessoes_lanchei').where({ id: sid }).first()).revogada_em).not.toBeNull();
  });
});
