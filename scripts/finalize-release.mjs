import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const releaseDir = path.resolve('release');
const artifacts = fs
  .readdirSync(releaseDir)
  .filter((name) => /^PRENSA-(Instalador|Portatil)-.*\.exe$/i.test(name))
  .sort();

if (artifacts.length < 2) {
  throw new Error(`Esperava instalador e portátil em ${releaseDir}; encontrei: ${artifacts.join(', ') || 'nenhum'}`);
}

const sums = artifacts.map((name) => {
  const data = fs.readFileSync(path.join(releaseDir, name));
  return `${crypto.createHash('sha256').update(data).digest('hex')}  ${name}`;
});

const instructions = `PRENSA — PACOTE DE PLAYTESTE
================================

OPÇÃO SEM INSTALAÇÃO
Abra PRENSA-Portatil-*.exe. Ele não instala nada e pode ser executado de um
pendrive ou de uma pasta comum. Na primeira abertura, o Windows pode analisar
e extrair o pacote por alguns segundos. A tela PREPARANDO O JOGO confirma que
ele está trabalhando; não abra uma segunda cópia.

OPÇÃO COM ATALHO
Abra PRENSA-Instalador-*.exe. O assistente instala apenas para o usuário atual,
sem exigir Node, npm, terminal ou conexão com a internet. Depois de instalado,
é o formato que abre mais rápido nas partidas seguintes.

CONTROLES
1–9       escolher uma ação / programar um slot
W/A/S/D   transmitir uma direção fixa no LABIRINTO
0         cortar/reabrir o rádio; segure na varredura para extração manual
ENTER     confirmar / continuar
ESC       pular a introdução
M         som ligado/desligado
P         modo de desempenho
F11       tela cheia

TREINAMENTO
O menu inicial possui DEMONSTRAÇÃO GUIADA e SIMULAÇÃO REAL para os quatro
protocolos. Elas não movem a esteira nem registram erros. A demonstração do
LABIRINTO pausa somente enquanto há uma decisão aberta; a simulação real não
pausa. No treino, CTRL+D oferece ajuda gradual, CTRL+R reinicia e ESC volta ao
manual.

WINDOWS SMARTSCREEN
Esta versão de playteste ainda não possui certificado comercial. Se o Windows
mostrar “Editor desconhecido”, use “Mais informações” e “Executar assim mesmo”.
Baixe/receba o arquivo somente da pessoa que está conduzindo o playteste.

PARA RELATAR UM PROBLEMA
Anote o nome da missão, o que escolheu, o que esperava acontecer e o que
aconteceu. Uma captura de tela ajuda bastante.
`;

fs.writeFileSync(path.join(releaseDir, 'COMO-TESTAR.txt'), instructions, 'utf8');
fs.writeFileSync(path.join(releaseDir, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`, 'utf8');
console.log(`Pacote finalizado: ${artifacts.join(', ')}`);
