// Dinheiro no front. A regra é a mesma do backend: SEMPRE centavos inteiros.
//
// Por que nunca parseFloat? Porque o computador guarda 0,1 + 0,2 como
// 0,30000000000000004. Num sistema de pagamento, esse "quase" vira um
// centavo errado no saldo de uma criança. Por isso, quando a pessoa digita
// "12,50", o texto é convertido em 1250 olhando os DÍGITOS, sem passar por
// número decimal em nenhum momento.

const formatador = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/** 1250 → "R$ 12,50"; -600 → "-R$ 6,00". Usa espaço normal (o Intl coloca um espaço "inquebrável"). */
export function formatarCentavos(centavos: number): string {
  if (!Number.isSafeInteger(centavos)) throw new Error('centavos deve ser um número inteiro');
  return formatador.format(centavos / 100).replace(/ /g, ' ');
}

/** 1250 → "12,50" (sem o "R$"; para preencher um campo de edição). */
export function centavosParaTexto(centavos: number): string {
  const sinal = centavos < 0 ? '-' : '';
  const abs = Math.abs(centavos);
  const reais = Math.trunc(abs / 100).toLocaleString('pt-BR');
  return `${sinal}${reais},${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Texto em reais → centavos. Para quando a pessoa COLA um valor ou o campo
 * é livre. Aceita: "12", "12,5", "12,50", "1.234,56", "R$ 12,50", "12.50"
 * (ponto como decimal só quando tem 1 ou 2 casas depois dele).
 * Devolve null se não for um valor válido (o campo mostra o erro).
 */
export function textoParaCentavos(texto: string): number | null {
  let t = texto.replace(/R\$|\s| /gi, '');
  if (t === '') return null;
  const negativo = t.startsWith('-');
  if (negativo) t = t.slice(1);

  let reais: string;
  let centavos = '';
  if (t.includes(',')) {
    // Formato brasileiro: pontos são separadores de milhar; a vírgula é a decimal.
    const [antes, depois, ...resto] = t.split(',');
    if (resto.length > 0 || depois === undefined) return null;
    if (!/^\d{1,3}(\.\d{3})*$|^\d+$/.test(antes ?? '')) return null;
    reais = (antes ?? '').replace(/\./g, '');
    centavos = depois;
  } else if (/^\d+\.\d{1,2}$/.test(t)) {
    // "12.50": ponto como decimal (comum ao colar de outro lugar).
    [reais, centavos] = t.split('.') as [string, string];
  } else if (/^\d{1,3}(\.\d{3})+$/.test(t)) {
    reais = t.replace(/\./g, ''); // "1.234" = mil duzentos e trinta e quatro reais
  } else {
    reais = t;
  }

  if (!/^\d+$/.test(reais) || !/^\d{0,2}$/.test(centavos)) return null;
  const valor = Number(reais) * 100 + Number(centavos.padEnd(2, '0') || '0');
  if (!Number.isSafeInteger(valor)) return null;
  return negativo ? -valor : valor;
}

/**
 * Digitação "de maquininha" (CampoDinheiro): cada dígito empurra os
 * anteriores para a esquerda. "1" → R$ 0,01; "12" → R$ 0,12; "1250" → R$ 12,50.
 * Recebe o que está no campo (com ou sem máscara) e devolve centavos.
 * Assim a pessoa nunca precisa digitar a vírgula.
 */
export function digitosParaCentavos(texto: string, maxDigitos = 9): number {
  const digitos = texto.replace(/\D/g, '').replace(/^0+/, '').slice(0, maxDigitos);
  return digitos === '' ? 0 : Number(digitos);
}
