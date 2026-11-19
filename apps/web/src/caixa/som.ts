// Bipes do caixa, gerados na hora com a Web Audio API (nenhum arquivo de som).
//   leitura: curto e agudo ("li a carteirinha")
//   aprovado: dois tons subindo
//   recusado: grave e mais longo (a atendente percebe sem olhar)
let contexto: AudioContext | null = null;

function tocar(notas: { frequencia: number; duracaoMs: number; inicioMs?: number }[], volume = 0.2) {
  try {
    contexto ??= new AudioContext();
    // O navegador só libera som depois de um toque do usuário (o login já foi um).
    if (contexto.state === 'suspended') void contexto.resume();
    const agora = contexto.currentTime;
    for (const n of notas) {
      const osc = contexto.createOscillator();
      const ganho = contexto.createGain();
      const inicio = agora + (n.inicioMs ?? 0) / 1000;
      const fim = inicio + n.duracaoMs / 1000;
      osc.type = 'sine';
      osc.frequency.value = n.frequencia;
      // Sobe e desce o volume rápido: sem o "clique" de ligar/desligar seco.
      ganho.gain.setValueAtTime(0.0001, inicio);
      ganho.gain.exponentialRampToValueAtTime(volume, inicio + 0.01);
      ganho.gain.exponentialRampToValueAtTime(0.0001, fim);
      osc.connect(ganho).connect(contexto.destination);
      osc.start(inicio);
      osc.stop(fim + 0.02);
    }
  } catch {
    // aparelho sem áudio: segue sem som
  }
}

export const som = {
  leitura() {
    tocar([{ frequencia: 1320, duracaoMs: 80 }]);
    navigator.vibrate?.(60);
  },
  aprovado: () => tocar([{ frequencia: 880, duracaoMs: 110 }, { frequencia: 1320, duracaoMs: 160, inicioMs: 120 }]),
  recusado: () => tocar([{ frequencia: 220, duracaoMs: 450 }], 0.3),
};
