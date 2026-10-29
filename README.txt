PIXZIN VEGAS — CONTAS PERSISTENTES COM ARQUIVO JSON
====================================================

O QUE ESTA VERSÃO ENTREGA
- Mantém o site Vegas e a conexão existente com wss://pixzin.onrender.com.
- Cadastro com nick único e senha de 10 a 128 caracteres.
- Senhas armazenadas como hash bcrypt (fator 12), nunca em texto puro.
- Contas, sessões, pontos, fichas e inventário básico guardados em /var/data/accounts.json.
- Limite inicial de 500 contas (MAX_ACCOUNTS no Render; máximo configurável até 5000).
- Escrita em arquivo temporário seguida de renomeação para reduzir risco de arquivo JSON parcial.
- API: /api/register, /api/login, /api/me, /api/logout, /api/profile e /api/ranking.
- Mantém PeerJS em /peerjs e presença WebSocket em /presence.
- Não usa SQLite nem Supabase.

IMPORTANTE SOBRE PERSISTÊNCIA
O arquivo accounts.json deve ficar no disco persistente do Render montado em /var/data. Nunca coloque esse arquivo na pasta pública do Netlify ou no repositório Git. Se o disco persistente não estiver anexado ao serviço, as contas podem ser perdidas em reinicializações ou implantações. Esta implementação é indicada para um único processo Node.js; não escale para múltiplas instâncias, pois um JSON local não coordena escritas entre servidores.

PUBLICAÇÃO — REPOSITÓRIO pixzincc / HOST EXISTENTE pixzin.onrender.com
1. Extraia o ZIP. O conteúdo completo deve ficar na raiz do repositório pixzincc: index.html, server/, render.yaml, netlify.toml e README.txt.
2. Não cole somente o index.html no repositório ligado ao Render: o backend está dentro da pasta server/.
3. No Render, abra o Web Service que deveria usar o endereço pixzin.onrender.com e confira qual repositório está conectado. Se estiver ligado ao repositório errado, conecte-o ao pixzincc (ou envie estes arquivos para o repositório já conectado). Faça isso no serviço EXISTENTE para preservar o hostname, se ele for mesmo pixzin.onrender.com.
4. Nas configurações desse serviço, configure Root Directory = server, Build Command = npm install e Start Command = npm start. Se o serviço usa Blueprint a partir do render.yaml, o nome do serviço neste arquivo está definido como pixzin para combinar com o hostname desejado; não crie um segundo serviço sem conferir o hostname gerado.
5. Configure DATA_DIR=/var/data, DATA_FILE=/var/data/accounts.json, MAX_ACCOUNTS=500 e SITE_ORIGIN=https://pixzin.netlify.app (sem barra final; troque se o domínio Netlify for outro).
6. Anexe disco persistente ao serviço, montado em /var/data. Não apague nem recrie um disco existente que possa conter contas.
7. No Netlify, publique o conteúdo da raiz do projeto, onde está index.html. Não publique a pasta server como site.
8. A linha SIGNAL_SERVER_URL do index.html deve continuar como wss://pixzin.onrender.com enquanto esse for o hostname real do backend. A URL da API deriva dessa linha automaticamente; não troque para pixzincc.onrender.com, pois pixzincc é o nome do repositório GitHub, não necessariamente o hostname Render.
9. Depois do deploy do backend, abra https://pixzin.onrender.com/health. Deve retornar JSON com status=ok e storage=json-file. Só então teste cadastro/login e ranking.

TESTE LOCAL (Node.js 20+)
  cd server
  npm install
  mkdir data
  DATA_DIR=./data DATA_FILE=./data/accounts.json MAX_ACCOUNTS=500 SITE_ORIGIN=http://localhost:8888 npm start
No PowerShell:
  cd server
  npm install
  New-Item -ItemType Directory -Force data
  $env:DATA_DIR="./data"
  $env:DATA_FILE="./data/accounts.json"
  $env:MAX_ACCOUNTS="500"
  $env:SITE_ORIGIN="http://localhost:8888"
  npm start
Abra http://localhost:3000/health.

SEGURANÇA E LIMITAÇÕES
- Senhas: o servidor guarda hashes bcrypt, não senhas originais. Não inclua accounts.json no GitHub nem no deploy público.
- O ranking omite senha, hash, tokens e IDs internos.
- O token de login fica no sessionStorage do navegador; pode ser necessário entrar de novo ao fechar a sessão, mas a conta permanece no servidor.
- JSON não é um banco transacional. Este serviço foi pensado para uma instância única e carga pequena. Não escale horizontalmente.
- O frontend legado ainda possui partes da economia local. As mensagens score-update podem atualizar pontos/saldo com dados enviados pelo cliente; isso não é resistente a trapaças. Não use para dinheiro real nem prêmios de valor real. Antes de abrir ao público, mova apostas, compras e recompensas para rotas validadas no servidor e implemente backup, limitação de tentativas e controle de concorrência.
- O plano gratuito do Render pode dormir; isso não apaga dados do disco persistente, mas pode atrasar a conexão.


DIAGNÓSTICO DO ERRO “FAILED TO FETCH” E DO REPOSITÓRIO pixzincc (29/10/2026)
1. O site chama https://pixzin.onrender.com/api/register. Esse erro normalmente significa que o backend de contas ainda não foi implantado no Render, está indisponível, ou o SITE_ORIGIN não corresponde ao domínio Netlify.
2. Abra https://pixzin.onrender.com/health. A versão correta deve responder status=ok e storage=json-file.
3. No Render, confirme SITE_ORIGIN exatamente igual à origem do site (ex.: https://pixzin.netlify.app), sem barra no final.
4. Faça deploy/redeploy do serviço Node.js com a pasta server deste pacote, root directory=server, build command=npm install, start command=npm start e disco persistente em /var/data. Confira também se o serviço está conectado ao repositório pixzincc que contém a pasta server/.
5. O Netlify não consegue publicar/atualizar o backend Render. Se o serviço Render atual ainda roda o servidor antigo, atualizar apenas o HTML não resolve o cadastro.
6. O repositório GitHub chamar-se pixzincc não muda automaticamente o endereço Render. A linha SIGNAL_SERVER_URL deve apontar para o hostname real do serviço; este pacote preserva wss://pixzin.onrender.com. O nome pixzincc é apenas o repositório, enquanto pixzin.onrender.com é o servidor esperado.
7. O botão flutuante de WhatsApp foi removido; ações contextuais de compartilhar/enviar dentro do jogo continuam disponíveis.


RECURSO SECRETO 777
- O jogo 777 aparece apenas ao pesquisar exatamente “777” na lista de jogos. A senha não é exibida na interface.
- Uma pergunta diária por conta é validada no backend e registrada no arquivo JSON persistente.
- A resposta do gnomo é gerada no servidor; o resultado sorteia ganho ou perda de fichas fictícias e o saldo atualizado é salvo.
- Requer publicar a versão atualizada do backend e do frontend. A regra diária usa o dia UTC no servidor; não é uma garantia exata de 24 horas após a consulta.
- As fichas são virtuais e sem valor monetário. O resultado é aleatório, não aconselhamento nem previsão real.
