PIXZIN VEGAS — CONTAS PERMANENTES (Render + Node.js + SQLite)
===========================================================

O QUE ESTA VERSÃO ENTREGA
- Mantém o site Vegas e os jogos existentes.
- Cadastro com nick único e senha (mínimo 10 caracteres).
- Login por conta; o WebSocket de presença exige token de sessão.
- Senhas nunca são armazenadas em texto puro: usa bcrypt com fator 12.
- SQLite privado em /var/data/pixzin.sqlite, montado num disco persistente do Render.
- Rotas API: /api/register, /api/login, /api/me, /api/logout, /api/profile e /api/ranking.
- Tabela de transações registra o saldo inicial; estrutura pronta para expandir inventário e economia.
- O ranking público retorna apenas username, points, credits e wins, nunca hash de senha ou token.
- Health check em /health.
- Mantém PeerJS e WebSocket de presença em /peerjs e /presence.
- Não usa Supabase.

PUBLICAÇÃO — PASSO A PASSO
1. Extraia este ZIP numa pasta no computador.
2. Crie um repositório privado no GitHub (recomendado) e envie TODO o conteúdo do ZIP.
   Pelo terminal, dentro da pasta extraída:
     git init
     git add .
     git commit -m "Pixzin Vegas com contas persistentes"
     git branch -M main
     git remote add origin https://github.com/SEU-USUARIO/pixzin-vegas.git
     git push -u origin main
   Substitua a URL pelo seu repositório. Se o Git pedir credenciais, use o fluxo de autenticação do GitHub; não cole tokens em arquivos.
3. No Render, crie um Web Service conectado ao repositório. O arquivo render.yaml define rootDir=server, npm install, npm start e um disco persistente de 1 GB montado em /var/data. Se usar Blueprint, revise o serviço e confirme que o disco está incluído.
4. No Render, defina SITE_ORIGIN com a URL EXATA do Netlify, por exemplo https://pixzin.netlify.app (sem barra no final). Não use * em produção.
5. Publique a pasta raiz do projeto no Netlify (a pasta que contém index.html). Se usar deploy manual, arraste o conteúdo da raiz, não a pasta server.
6. Confirme o endereço do Render. O projeto vem configurado para wss://pixzin.onrender.com. Se o seu serviço tiver outro hostname, substitua SIGNAL_SERVER_URL no index.html pelo endereço WSS real.
7. Após o deploy, abra https://SEU-SERVICO.onrender.com/health. Deve retornar JSON com status "ok" e database "sqlite".
8. Abra o site Netlify, crie uma conta e saia. Crie uma segunda conta com outro nick.
9. Confirme no ranking que aparecem os usuários online. Feche a aba, reabra e faça login novamente: a conta e os dados armazenados no SQLite permanecem.
10. No Render, confirme que o disco persistente está ligado ao serviço. Não remova o disco: apagar o disco apaga os dados do banco.

TESTE LOCAL OPCIONAL
Requer Node.js 20+ e dependências nativas necessárias para better-sqlite3.
  cd server
  npm install
  mkdir data
  DATA_DIR=./data SITE_ORIGIN=http://localhost:8888 npm start
No Windows PowerShell:
  cd server
  npm install
  New-Item -ItemType Directory -Force data
  $env:DATA_DIR="./data"
  $env:SITE_ORIGIN="http://localhost:8888"
  npm start
Abra http://localhost:3000/health para verificar o servidor. Para teste completo do frontend, sirva index.html por HTTP e configure a URL do servidor conforme seu ambiente.

ARMAZENAMENTO E SENHAS
- Banco padrão: /var/data/pixzin.sqlite. O caminho pode ser alterado com DB_PATH ou DATA_DIR.
- Senhas: bcrypt hash, nunca texto puro. Os hashes ainda são dados sensíveis; não os exponha.
- Tokens de sessão são aleatórios; o banco guarda somente o hash do token.
- O token do navegador fica em sessionStorage, e não no ranking. Ao fechar a sessão do navegador, o usuário pode precisar entrar novamente; seu progresso continua no servidor.
- O ranking nunca inclui senha, hash, token, email ou ID interno.
- O SQLite deve permanecer em disco privado, nunca dentro da pasta publicada pelo Netlify.

LIMITAÇÕES IMPORTANTES / ANTES DE LANÇAR PARA O PÚBLICO
- Esta é uma base funcional para contas persistentes, mas NÃO é uma plataforma pronta para fichas com valor comercial, dinheiro real, depósitos ou saques.
- O endpoint /api/profile e a mensagem WS score-update aceitam pontuação enviada pelo cliente com limites básicos. Para evitar trapaça, a próxima etapa obrigatória é mover cada recompensa, aposta, compra e mudança de saldo para operações server-side atômicas, com histórico de transações e idempotência. Não use para prêmios de valor real.
- A coluna inventory está preparada, mas as skins/loja do frontend antigo ainda podem ter lógica local. Não assuma que compras/inventário estejam sincronizados entre dispositivos até integrar cada ação da loja com endpoints de servidor.
- Configure rate limiting, HTTPS, política de origem estrita, backups e monitoramento antes de divulgação ampla.
- SITE_ORIGIN deve ser a origem exata do Netlify. Se usar domínio próprio, configure esse domínio.
- Serviço gratuito pode dormir. A conexão WSS pode demorar a acordar.
- Faça backup do disco e nunca compartilhe a URL interna, arquivo SQLite, tokens ou hashes.
