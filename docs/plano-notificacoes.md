# Notificações de feature do squad

Objetivo: avisar a pessoa quando algo importante acontece numa feature durante uma execução (sprint, feature isolada ou spawn), mesmo com a aba em segundo plano, sem virar ruído.

## 1. Mapa: onde os eventos acontecem hoje (src/app.js)

Evento | Onde nasce | Hoje avisa com | Pede ação?
--- | --- | --- | ---
Plano do comandante aguardando aprovação | planWithCommander, `owner.phase='awaiting'` (~2548) | card no chat da operação | sim: Executar plano
Comandante falhou / plano inválido, usou distribuição padrão | planWithCommander, `note` (~2533-2546) | mensagem system warn | não (aviso)
Nenhuma rota possível na squad | planWithCommander, `!routed.length` (~2547) | system error, runner encerrado | sim: completar squad
Feature fechou a rota e foi para revisão humana | advanceRoute, ramo `else` (~2619) | log + baton + toast só se `runner.single` | sim: Aprovar / Solicitar ajustes
Agente falhou numa etapa (live) | liveStep, `exit.error/isError` (~2629) | toast error + system error, execução para | sim: ver erro, rodar de novo
Rota com agente que saiu da squad | launchNext (~2595) | system error, runner encerrado | sim: redistribuir
Fim da rodada (sprint/feature) com resumo | launchNext, sem próxima feature (~2594) | fala do comandante + toast | às vezes: revisões pendentes
Feature desbloqueada por aprovação | approveFeature → refreshBlocked (1219, 2668) | nada | não (informativo)
Pausa efetivada depois da etapa em andamento | startRun / liveStep (inFlight) | system | não

Fica de fora (não é "importante"): passagem de bastão entre agentes, chips de ferramenta, chamadas entre colegas, ações feitas pela própria pessoa (aprovar, cancelar, parar).

Base existente que dá para reaproveitar: `toast` (607, some em 5,5 s e não fica histórico), `log()` (registro persistido), `roomPush` (chat da operação), `visibilitychange` já usado por `diskRefresh`, `.system-meta` no topo (shell.html) para o sino.

## 2. Desenho

Um ponto central, `notify(kind, {p, f, agentId, text})`, chamado nos pontos acima (uma linha em cada). Ele decide os canais pelas preferências e deduplica por `kind|projectId|featureId|f.runStart` para re-render não repetir aviso.

Tipos (`NOTIFY_KINDS`, rótulo + tom + se pede ação):
  plan-awaiting   ação   "Plano da Sprint 01 pronto para aprovar"
  plan-fallback   aviso
  plan-empty      erro   ação
  review          ação   "F03 está pronta para revisão"
  step-failed     erro   ação
  route-broken    erro   ação
  round-end       info
  unblocked       info   (desligado por padrão)

Canais:
  a. Central no app: sino em `.system-meta` com contador de não lidas; painel (popover) com a lista, tempo relativo, projeto/feature, botão que leva ao lugar (review → openOpsFeature, plano → openOpsChat, falha → feature + console Histórico). "Marcar todas como lidas" e limpar.
  b. Notificação do sistema (Notification API) só quando `document.hidden` ou sem foco. Permissão pedida por clique em Configurações, nunca no carregamento. Clique na notificação: `window.focus()` + mesmo destino do item. `tag` = chave de dedup, para o SO substituir em vez de empilhar.
  c. Título da aba com contador "(2) SQUAD/CODE" enquanto houver não lidas de ação.
  d. Som curto opcional (WebAudio, sem arquivo), desligado por padrão.
  O toast atual continua para quem está olhando.

Preferências (persistidas): `state.settings.notify = {desktop:false, sound:false, title:true, kinds:{...}}` em `DEFAULT_SETTINGS` (388) e em `normalizeWorkspace` (442), whitelist campo a campo. Nova aba "Notificações" em Configurações (`openSettings`, 2696, `settingsTab==='notify'`) com status da permissão do navegador, botão "Permitir notificações", interruptor por tipo e "Enviar teste".

Onde guardar a lista: localStorage por origem (`squad-code.notifications.v1`, máx. 100, evento `storage` sincroniza outras abas). Motivo: quem roda é a aba que tem o runner; pôr no workspace faria cada aviso gerar PUT, trocar rev e conflitar entre abas. A lista não entra no export.

Demo (file:// ou sem bridge): dispara igual, com marca DEMO no item; notificação do sistema só se já houver permissão.

## 3. Passos

1. `NOTIFY_KINDS`, `notify()`, store em localStorage, dedup (function declarations, por causa do TDZ no boot).
2. Ligar `notify` nos 8 pontos do mapa (edições por string exata, `node --check src/app.js` após cada uma).
3. Sino + painel: HTML em `src/shell.html`, estilos em `src/styles.css`, render no `render()` sem mexer em blocos com input (signature própria), `data-action` novas: `notif-open`, `notif-go`, `notif-read-all`, `notif-clear`.
4. Notification API + título da aba + som.
5. Aba de Configurações + `settings.notify` em DEFAULT_SETTINGS/normalizeWorkspace/seedWorkspace.
6. Testes: `tests/ui_test.py` (Playwright com permissão `notifications` concedida e `Notification` instrumentado): rodar a sprint do exemplo em demo, aprovar plano, conferir itens plan-awaiting e review, contador do sino, título da aba, clique leva à feature, dedup após re-render. `npm test` para garantir que o bridge não mudou.
7. Atualizar CLAUDE.md (seção de app.js) e docs/GUIA.md.

## 4. E-mail (feito junto com a v1, Gmail por SMTP)

O e-mail sai do bridge (`mailer.js`, sem dependência nova): cliente SMTP com TLS na 465 (STARTTLS nas outras portas), conta e senha de app só no ambiente ou no `.env` ao lado do `server.js`, destinatário também só no ambiente (a página nunca escolhe). Cada tipo tem o canal "Desligado / No app / App + e-mail". O bridge junta os avisos de 60 s num e-mail e manda no máximo 20 por hora. A simulação nunca manda e-mail. Testes com um SMTP falso em loopback.

Limite que continua: o runner vive na página. Com a aba ou o bridge fechados, ou o Mac dormindo, nada roda nem avisa. Trocar de usuário no macOS não interrompe.

## 5. Depois

Slack/Discord por webhook entrariam no mesmo `notify()` com um segundo canal no bridge. Rodar e avisar com a aba fechada exige levar o runner para o bridge, que é outra feature.
