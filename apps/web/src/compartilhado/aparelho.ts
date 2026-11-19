// Preferências DESTE aparelho (localStorage): nome do caixa e câmera escolhida.
// Não são dados pessoais; ficam no tablet e não vão para o servidor.
// O acesso fica dentro de try/catch: em modo privado, o localStorage pode falhar.

function ler(chave: string): string | null {
  try {
    return localStorage.getItem(chave);
  } catch {
    return null;
  }
}
function gravar(chave: string, valor: string) {
  try {
    localStorage.setItem(chave, valor);
  } catch {
    // sem armazenamento: vale só até recarregar
  }
}

export const nomeDoCaixa = () => ler('lanchei:nome-caixa') || 'Caixa 1';
export const definirNomeDoCaixa = (nome: string) => gravar('lanchei:nome-caixa', nome.trim().slice(0, 20) || 'Caixa 1');

export type Camera = 'environment' | 'user';
/** Traseira por padrão: com o tablet num suporte virado para a atendente, ela aponta para o aluno. */
export const cameraPreferida = (): Camera => (ler('lanchei:camera') === 'user' ? 'user' : 'environment');
export const definirCamera = (c: Camera) => gravar('lanchei:camera', c);
