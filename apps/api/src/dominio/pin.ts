// PIN de 4 dígitos para a "compra sem carteirinha". Função pura.
//
// O PIN é a única coisa entre um colega mal-intencionado e o saldo do aluno
// quando a carteirinha fica em casa. Por isso recusamos os PINs que qualquer
// um tentaria primeiro. (Com 5 erros ele trava por 30 min: chutar 4 dígitos
// "aleatórios" não funciona; chutar "1234" funcionaria.)

export function pinObvio(pin: string): boolean {
  if (!/^\d{4}$/.test(pin)) return true;
  const d = [...pin].map(Number);
  const passos = [d[1]! - d[0]!, d[2]! - d[1]!, d[3]! - d[2]!];
  if (passos.every((p) => p === 0)) return true; // 0000, 1111 ... 9999
  if (passos.every((p) => p === 1) || passos.every((p) => p === -1)) return true; // 0123, 1234 ... 9876, 4321
  if (d[0] === d[2] && d[1] === d[3]) return true; // 1212, 2020, 6969 (ABAB)
  if (d[0] === d[1] && d[2] === d[3]) return true; // 1122, 0099 (AABB)
  if (d[0] === d[3] && d[1] === d[2]) return true; // 1221, 2002 (ABBA)
  return false;
}
