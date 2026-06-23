import { tr } from './extension-locale.js';

export interface HandoffSettingsViewState {
  locale: 'en' | 'ru';
  isWindows: boolean;
  serverHost: string;
  serverPort: number;
  webappPassword: string;
  telegramEnabled: boolean;
  telegramBotToken: string;
  telegramAllowedUsers: string;
  telegramImpl: string;
  telegramRegisterToken: string;
  telegramRegisteredUsers: { id: number; username?: string; firstName?: string; registeredAt?: string }[];
  wakeInstalled: boolean;
  wakeRunning: boolean;
  wakeRaiseCursor: boolean;
  wakeStartupEnabled: boolean;
  cloudflaredInstalled: boolean;
  tunnelRunning: boolean;
  tunnelUrl: string | null;
  tunnelAutostartEnabled: boolean;
}

export function makeTr(dict: Record<string, string>): (key: string, enFallback: string) => string {
  return (key, enFallback) => tr(dict, key, enFallback);
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wakeStatusLabel(state: HandoffSettingsViewState, t: ReturnType<typeof makeTr>): string {
  if (!state.wakeInstalled) return t('ext.handoffSettings.wake.notInstalled', 'Not installed');
  if (state.wakeRunning) {
    return state.wakeRaiseCursor
      ? t('ext.handoffSettings.wake.running', 'Running')
      : t('ext.handoffSettings.wake.paused', 'Paused');
  }
  return t('ext.handoffSettings.wake.stopped', 'Stopped');
}

function tunnelStatusLabel(state: HandoffSettingsViewState, t: ReturnType<typeof makeTr>): string {
  if (!state.cloudflaredInstalled) return t('ext.handoffSettings.cloud.notInstalled', 'cloudflared not installed');
  if (state.tunnelRunning) return t('ext.handoffSettings.cloud.running', 'Tunnel running');
  return t('ext.handoffSettings.cloud.stopped', 'Tunnel stopped');
}

function wakeTone(state: HandoffSettingsViewState): 'ok' | 'warn' | 'muted' {
  if (!state.wakeInstalled || !state.wakeRunning) return 'muted';
  return state.wakeRaiseCursor ? 'ok' : 'warn';
}

function tunnelTone(state: HandoffSettingsViewState): 'ok' | 'muted' {
  if (!state.cloudflaredInstalled) return 'muted';
  return state.tunnelRunning ? 'ok' : 'muted';
}

function statusLine(tone: 'ok' | 'warn' | 'bad' | 'muted', text: string): string {
  return `<div class="status-line"><span class="dot ${tone}"></span><span class="val ${tone}">${escapeHtml(text)}</span></div>`;
}

function actBtn(id: string, icon: string, label: string, tone: 'ok' | 'warn' | 'bad' | '' = ''): string {
  return `<button type="button" class="act${tone ? ` tone-${tone}` : ''}" id="${id}"><span class="act-ico">${icon}</span><span class="act-lbl">${escapeHtml(label)}</span></button>`;
}

function saveBtn(id: string, label: string): string {
  return `<button type="button" class="save" id="${id}">${escapeHtml(label)}</button>`;
}

function card(id: string, title: string, body: string): string {
  return `<section class="card" id="${escapeHtml(id)}"><h2 class="card-h">${escapeHtml(title)}</h2>${body}</section>`;
}

function cfgRow(label: string, control: string): string {
  return `<div class="cfg-row"><span class="cfg-lbl">${escapeHtml(label)}</span><div class="cfg-ctl">${control}</div></div>`;
}

function tgTicks(...items: string[]): string {
  return `<ul class="ticks">${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
}

function linkBotFather(text: string): string {
  return escapeHtml(text)
    .replace('@BotFather', '<a href="#" class="lnk" data-action="openExternal" data-url="https://t.me/BotFather">@BotFather</a>')
    .replace('/newbot', '<code>/newbot</code>');
}

function linkUserinfobot(text: string): string {
  return escapeHtml(text)
    .replace('@userinfobot', '<a href="#" class="lnk" data-action="openExternal" data-url="https://t.me/userinfobot">@userinfobot</a>');
}

function linkBridge(text: string): string {
  return escapeHtml(text)
    .replace('/bridge_all', '<code>/bridge_all</code>')
    .replace('/bridge', '<code>/bridge</code>');
}

function tgStep(n: number, title: string, body: string, done: boolean): string {
  return `<div class="tg-step${done ? ' done' : ''}">
    <div class="tg-n">${done ? '✓' : n}</div>
    <div class="tg-body"><h3>${escapeHtml(title)}</h3>${body}</div>
  </div>`;
}

export function renderHandoffSettingsHtml(state: HandoffSettingsViewState, dict: Record<string, string>): string {
  const t = makeTr(dict);
  const networkMode = state.serverHost === '127.0.0.1' ? 'localhost'
    : state.serverHost === '0.0.0.0' ? 'lan' : 'custom';
  const customAddress = networkMode === 'custom' ? state.serverHost : '';
  const hasBotToken = !!state.telegramBotToken;
  const hasAllowedUsers = state.telegramAllowedUsers.split(',').some((s) => /^\d+$/.test(s.trim()));
  const maskedToken = hasBotToken ? state.telegramBotToken.slice(0, 6) + '...' + state.telegramBotToken.slice(-4) : '';
  const browserHost = state.serverHost === '0.0.0.0' ? '<your-ip>' : state.serverHost;
  const tgReg = state.telegramRegisteredUsers.length > 0;
  const hasPw = !!state.webappPassword.trim();
  const needsPasswordWarn = networkMode !== 'localhost' && !hasPw;

  const tgBotSteps = tgTicks(
    linkBotFather(t('ext.handoffSettings.telegram.step1.s1', 'In Telegram, open @BotFather — the official bot from Telegram.')),
    linkBotFather(t('ext.handoffSettings.telegram.step1.s2', 'Send /newbot, then follow the prompts: choose a display name and a username ending in bot.')),
    escapeHtml(t('ext.handoffSettings.telegram.step1.s3', 'BotFather sends a long token (digits, colon, letters). Copy the entire line.')),
    escapeHtml(t('ext.handoffSettings.telegram.step1.s4', 'Paste it below and press Save token. It stays on this PC only.')),
  );
  const tgIdSteps = tgTicks(
    linkUserinfobot(t('ext.handoffSettings.telegram.step2.s1', 'In Telegram, message @userinfobot — it replies with your numeric user ID.')),
    escapeHtml(t('ext.handoffSettings.telegram.step2.s2', 'Paste that number below. Several people? Separate IDs with commas, then Save.')),
  );
  const tgGroupSteps = tgTicks(
    escapeHtml(t('ext.handoffSettings.telegram.step3.s1', 'Create a new Telegram group and add your bot as a member.')),
    escapeHtml(t('ext.handoffSettings.telegram.step3.s2', 'Group menu → Topics → Enable. The group becomes a supergroup with forum threads.')),
    escapeHtml(t('ext.handoffSettings.telegram.step3.s3', 'Group menu → Administrators → promote the bot. Enable Manage topics, Delete messages, and Pin messages.')),
  );
  const tgRegSteps = tgTicks(
    escapeHtml(t('ext.handoffSettings.telegram.step4.s1', 'Start the Handoff server (sidebar must show Running).')),
    escapeHtml(t('ext.handoffSettings.telegram.step4.s2', 'Copy /register … below and send it in the group — any topic works.')),
    escapeHtml(t('ext.handoffSettings.telegram.step4.s3', 'When it succeeds, your account appears in this step.')),
  );
  const tgBridgeSteps = tgTicks(
    escapeHtml(t('ext.handoffSettings.telegram.step5.s1', 'In the group, open the # General topic (main channel, not a project thread).')),
    linkBridge(t('ext.handoffSettings.telegram.step5.s2', 'Send /bridge — Handoff creates topics for Cursor tabs that already have chat messages.')),
    linkBridge(t('ext.handoffSettings.telegram.step5.s3', 'Want a topic for every open tab? Send /bridge_all instead.')),
  );

  const netLocalHint = escapeHtml(t('ext.handoffSettings.network.localhost.hint', '127.0.0.1 — open the web UI in a browser on this machine.'));
  const netLanHint = escapeHtml(t('ext.handoffSettings.network.lan.hint', '0.0.0.0 — phones and tablets on your LAN. Set a web password first.'));
  const netCustomHint = escapeHtml(t('ext.handoffSettings.network.custom.hint', 'Paste a Tailscale address or another interface IP you want to bind to.'));
  const netHintNow = networkMode === 'lan' ? netLanHint : networkMode === 'custom' ? netCustomHint : netLocalHint;
  const accessTone = networkMode === 'localhost' ? 'muted' : hasPw ? 'ok' : 'warn';

  const bindOpt = (mode: string, label: string) =>
    `<button type="button" class="bind-opt${networkMode === mode ? ' on' : ''}" data-net="${mode}">${escapeHtml(label)}</button>`;

  const accessAbout = tgTicks(
    escapeHtml(t('ext.handoffSettings.network.s1', 'Handoff serves a web UI on this PC while Cursor is running.')),
    escapeHtml(t('ext.handoffSettings.network.s2', 'Open the link on your phone — same chats as on the desktop.')),
    escapeHtml(t('ext.handoffSettings.network.s3', 'LAN and Custom reach beyond this machine — set a password first.')),
  );
  const wakeAbout = tgTicks(
    escapeHtml(t('ext.handoffSettings.wake.s1', 'Listens to Telegram while Cursor is closed.')),
    escapeHtml(t('ext.handoffSettings.wake.s2', 'Queues messages and can launch Cursor when something arrives.')),
    escapeHtml(t('ext.handoffSettings.wake.s3', 'Startup keeps Wake in the tray after Windows login.')),
  );
  const cloudAbout = tgTicks(
    escapeHtml(t('ext.handoffSettings.cloud.s1', 'Creates a temporary HTTPS URL — no VPN on the phone.')),
    escapeHtml(t('ext.handoffSettings.cloud.s2', 'Traffic is forwarded to Handoff on this PC. Web password required.')),
    escapeHtml(t('ext.handoffSettings.cloud.s3', 'Use /web_url in Telegram # General to post the current link.')),
  );

  const wTone = wakeTone(state);
  const wakePauseResume = state.wakeInstalled && state.wakeRunning
    ? (state.wakeRaiseCursor
      ? actBtn('pauseWake', '⏸', t('ext.handoffSettings.wake.pause', 'Pause'), 'warn')
      : actBtn('resumeWake', '▶', t('ext.handoffSettings.wake.resume', 'Resume'), 'ok'))
    : '';
  const wakeActions = state.wakeInstalled
    ? `<div class="act-list">${wakePauseResume}${actBtn('restartWake', '↻', t('ext.handoffSettings.wake.restart', 'Restart'))}${actBtn('uninstallWake', '🗑', t('ext.handoffSettings.wake.uninstall', 'Remove'), 'bad')}</div>`
    : `<div class="act-list">${actBtn('installWake', '▶', t('ext.handoffSettings.wake.install', 'Download & install'), 'ok')}</div>`;

  const nav = [
    { id: 'lang', label: t('ext.handoffSettings.language.label', 'Language') },
    { id: 'access', label: t('ext.handoffSettings.nav.web', 'Web access') },
    { id: 'telegram', label: t('ext.handoffSettings.tab.telegram', 'Telegram') },
    { id: 'addons', label: t('ext.handoffSettings.panel.addons', 'Add-ons') },
  ];

  const navHtml = nav.map((n) => `<a href="#${n.id}" class="rail-a" data-jump="${n.id}">${escapeHtml(n.label)}</a>`).join('');

  const sections = [
    card('lang', t('ext.handoffSettings.language.label', 'Language'),
      `<p class="lead">${escapeHtml(t('ext.handoffSettings.language.hint', 'Applies to Handoff settings, the sidebar, status bar, phone web UI, and Telegram replies.'))}</p>
       <div class="puck" data-locale-puck>
         <span class="puck-bg" style="transform:translateX(${state.locale === 'ru' ? '100%' : '0'})"></span>
         <label class="puck-side${state.locale === 'en' ? ' on' : ''}"><input type="radio" name="locale" value="en" ${state.locale === 'en' ? 'checked' : ''} />English</label>
         <label class="puck-side${state.locale === 'ru' ? ' on' : ''}"><input type="radio" name="locale" value="ru" ${state.locale === 'ru' ? 'checked' : ''} />Русский</label>
       </div>`),

    card('access', t('ext.handoffSettings.nav.web', 'Web access'),
      `${needsPasswordWarn ? `<div class="flare warn">${escapeHtml(t('ext.handoffSettings.network.passwordFirst', 'Set a web password before exposing LAN, Tailscale, or Cloudflare access.'))}</div>` : ''}
       <p class="lead">${escapeHtml(t('ext.handoffSettings.network.lead', 'Read and write in Cursor from a phone browser while Handoff runs on this PC.'))}</p>
       ${accessAbout}
       <p class="hint">${escapeHtml(t('ext.handoffSettings.network.endpointHint', 'Your link — copy after saving bind settings below.'))}</p>

       <div class="endpoint">
         <span class="dot ${accessTone}" id="endpointDot"></span>
         <span class="endpoint-url" id="endpointUrl">http://${escapeHtml(browserHost)}:${state.serverPort}</span>
         <button type="button" class="mini" id="copyEndpoint" title="${escapeHtml(t('web.common.copy', 'Copy'))}">⎘</button>
       </div>

       <div class="cfg">
         <div class="cfg-block">
           <div class="cfg-lbl">${escapeHtml(t('ext.handoffSettings.network.title', 'Bind'))}</div>
           <p class="hint cfg-intro">${escapeHtml(t('ext.handoffSettings.network.bindIntro', 'Localhost — this PC only. LAN — Wi‑Fi devices. Custom — Tailscale or a fixed IP.'))}</p>
           <div class="bind-seg" role="group">
             ${bindOpt('localhost', t('ext.handoffSettings.network.localhost.title', 'Localhost'))}
             ${bindOpt('lan', t('ext.handoffSettings.network.lan.title', 'LAN'))}
             ${bindOpt('custom', t('ext.handoffSettings.network.custom.title', 'Custom'))}
           </div>
           <select id="netModeSelect" class="sr-only" aria-hidden="true" tabindex="-1">
             <option value="localhost" data-hint="${netLocalHint}" ${networkMode === 'localhost' ? 'selected' : ''}></option>
             <option value="lan" data-hint="${netLanHint}" ${networkMode === 'lan' ? 'selected' : ''}></option>
             <option value="custom" data-hint="${netCustomHint}" ${networkMode === 'custom' ? 'selected' : ''}></option>
           </select>
           <p class="hint" id="netHint">${netHintNow}</p>
         </div>
         <div id="customAddrWrap" class="cfg-row" style="${networkMode === 'custom' ? '' : 'display:none'}">
           <span class="cfg-lbl">${escapeHtml(t('ext.handoffSettings.network.custom.addrLabel', 'Address'))}</span>
           <div class="cfg-ctl"><input type="text" id="customAddress" class="cfg-in" value="${escapeHtml(customAddress)}" placeholder="${escapeHtml(t('ext.handoffSettings.network.custom.placeholder', 'e.g. 100.64.0.1'))}" /></div>
         </div>
         ${cfgRow(t('ext.handoffSettings.password.title', 'Password'),
           `<div class="pw-row">
              <input type="text" id="passwordInput" class="cfg-in" value="${escapeHtml(state.webappPassword)}" autocomplete="off" placeholder="${escapeHtml(t('ext.handoffSettings.password.placeholder', 'Password'))}" />
              <button type="button" class="mini" id="copyPassword" title="${escapeHtml(t('web.common.copy', 'Copy'))}">⎘</button>
              <button type="button" class="save mini" id="savePassword">${escapeHtml(t('web.common.save', 'Save'))}</button>
            </div>`)}
         <p class="hint cfg-hint">${escapeHtml(t('ext.handoffSettings.password.description', 'Required when you open the server from a phone or another computer.'))}</p>
       </div>
       <p class="hint"><a href="#" class="lnk" data-action="openDoc" data-path="docs/guide.md#tailscale">${escapeHtml(t('ext.handoffSettings.network.tailscaleGuide', 'Tailscale guide'))}</a></p>
       ${saveBtn('saveNetworking', t('ext.handoffSettings.network.saveAndRestart', 'Save bind address and restart'))}`),

    card('telegram', t('ext.handoffSettings.tab.telegram', 'Telegram'),
      `<p class="lead">${escapeHtml(t('ext.handoffSettings.telegram.lead', 'Five steps, top to bottom. Each step unlocks the next — do them in order.'))}</p>
       <div class="tg-flow">
         ${tgStep(1, t('ext.handoffSettings.telegram.step1.title', 'Bot token'),
           `${hasBotToken ? `<p class="hint">${escapeHtml(t('ext.handoffSettings.telegram.step1.saved', 'Bot token saved.'))}</p><div class="beacon ok">${escapeHtml(maskedToken)}</div><p class="hint">${escapeHtml(t('ext.handoffSettings.telegram.step1.savedHint', 'To replace the bot, paste a new token from @BotFather below.'))}</p>` : `<p class="hint">${escapeHtml(t('ext.handoffSettings.telegram.step1.lead', 'Handoff talks to Telegram through your own bot — a small relay account you create once.'))}</p>${tgBotSteps}`}
            <label class="field"><span>${escapeHtml(hasBotToken ? t('ext.handoffSettings.telegram.step1.replace', 'New token') : t('ext.handoffSettings.telegram.step1.fieldLabel', 'Bot token'))}</span>
              <input type="text" id="botTokenInput" placeholder="${escapeHtml(hasBotToken ? t('ext.handoffSettings.telegram.step1.replacePlaceholder', 'Paste new token from @BotFather') : t('ext.handoffSettings.telegram.step1.placeholder', '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11'))}" autocomplete="off" />
            </label>
            ${saveBtn('saveToken', t('ext.handoffSettings.telegram.step1.saveToken', 'Save token'))}`,
           hasBotToken)}
         ${tgStep(2, t('ext.handoffSettings.telegram.step2.title', 'Who may use the bot'),
           `<p class="hint">${escapeHtml(t('ext.handoffSettings.telegram.step2.lead', 'A whitelist of Telegram accounts. Everyone else is ignored.'))}</p>${tgIdSteps}
            <label class="field"><span>${escapeHtml(t('ext.handoffSettings.telegram.step2.fieldLabel', 'Allowed user IDs'))}</span><input type="text" id="allowedUsersInput" value="${escapeHtml(state.telegramAllowedUsers)}" placeholder="${escapeHtml(t('ext.handoffSettings.telegram.step2.placeholder', 'e.g. 123456789'))}" /></label>
            ${saveBtn('saveAllowedUsers', t('ext.handoffSettings.telegram.step2.save', 'Save'))}`,
           hasAllowedUsers)}
         ${tgStep(3, t('ext.handoffSettings.telegram.step3.title', 'Telegram group'),
           `<p class="hint">${escapeHtml(t('ext.handoffSettings.telegram.step3.lead', 'Cursor chats will appear as separate topics inside one group.'))}</p>${tgGroupSteps}`,
           hasAllowedUsers)}
         ${tgStep(4, t('ext.handoffSettings.telegram.step4.title', 'Link this PC to the group'),
           `<p class="hint">${escapeHtml(t('ext.handoffSettings.telegram.step4.lead', 'Tells Handoff which Telegram group belongs to this computer.'))}</p>${tgRegSteps}
           ${tgReg
             ? `<p class="hint">${escapeHtml(t('ext.handoffSettings.telegram.step4.registered', 'Registered users:'))} <em>${escapeHtml(state.telegramRegisteredUsers.map((u) => u.username ? '@' + u.username : u.firstName ?? String(u.id)).join(', '))}</em></p>${state.telegramRegisterToken ? `<p class="hint">${escapeHtml(t('ext.handoffSettings.telegram.step4.registerHint', 'To register another user, send in the group:'))}</p><code class="beacon code">/register ${escapeHtml(state.telegramRegisterToken)}</code>${actBtn('copyRegister', '⎘', t('web.common.copy', 'Copy'))}` : ''}`
             : state.telegramRegisterToken
               ? `<p class="hint">${escapeHtml(t('ext.handoffSettings.telegram.step4.sendCommand', 'Send this command in the Telegram group:'))}</p><code class="beacon code">/register ${escapeHtml(state.telegramRegisterToken)}</code>${actBtn('copyRegister', '⎘', t('web.common.copy', 'Copy'))}`
               : `<p class="hint">${escapeHtml(t('ext.handoffSettings.telegram.step4.startServer', 'Start the Handoff server — the /register command will appear here.'))}</p>`}`,
           tgReg)}
         ${tgStep(5, t('ext.handoffSettings.telegram.step5.title', 'Create chat topics'),
           `<p class="hint">${escapeHtml(t('ext.handoffSettings.telegram.step5.lead', 'Each Cursor tab gets its own topic — that is where you write to the agent from your phone.'))}</p>${tgBridgeSteps}`,
           tgReg)}
       </div>
       <div class="tg-transport">
         <h3 class="sub">${escapeHtml(t('ext.handoffSettings.transport.title', 'Bot API transport'))}</h3>
         <p class="hint">${escapeHtml(t('ext.handoffSettings.transport.description', 'How the server talks to Telegram. Leave on Raw unless you know you need Grammy.'))}</p>
         <div class="impl-sw">
           <button type="button" class="impl-pick${state.telegramImpl === 'raw' ? ' on' : ''}" data-impl="raw">${escapeHtml(t('ext.handoffSettings.transport.raw.title', 'Raw (recommended)'))}</button>
           <button type="button" class="impl-pick${state.telegramImpl === 'grammy' ? ' on' : ''}" data-impl="grammy">${escapeHtml(t('ext.handoffSettings.transport.grammy.title', 'Grammy'))}</button>
         </div>
         <select id="tgImplSelect" class="sr-only" aria-hidden="true" tabindex="-1">
           <option value="raw" ${state.telegramImpl === 'raw' ? 'selected' : ''}></option>
           <option value="grammy" ${state.telegramImpl === 'grammy' ? 'selected' : ''}></option>
         </select>
         ${saveBtn('saveTgImpl', t('ext.handoffSettings.transport.saveAndRestart', 'Save transport and restart'))}
       </div>
       <p class="hint tg-foot"><a href="#" class="lnk" data-action="openDoc" data-path="docs/telegram.md#five-step-setup">${escapeHtml(t('ext.handoffSettings.telegram.guide', 'Telegram guide'))}</a></p>`),

    card('addons', t('ext.handoffSettings.panel.addons', 'Add-ons'),
      `<p class="lead">${escapeHtml(t('ext.handoffSettings.addons.lead', 'Optional helpers — install after Web and Telegram are configured.'))}</p>
       <div class="addon-grid">
         ${state.isWindows ? `<div class="addon" id="wake">
           <h3 class="sub">${escapeHtml(t('ext.handoffSettings.wake.title', 'CursorWake'))}</h3>
           <p class="hint">${escapeHtml(t('ext.handoffSettings.wake.lead', 'Windows tray companion — optional, for Telegram when Cursor is closed.'))}</p>
           ${wakeAbout}
           ${statusLine(wTone, wakeStatusLabel(state, t))}
           ${wakeActions}
           <label class="ck${state.wakeInstalled ? '' : ' off'}"><input type="checkbox" id="wakeStartup" ${state.wakeStartupEnabled ? 'checked' : ''} ${state.wakeInstalled ? '' : 'disabled'} /><span>${escapeHtml(t('ext.handoffSettings.wake.autostart', 'Start Wake on Windows login (Startup)'))}</span></label>
           <p class="hint"><a href="#" class="lnk" data-action="openDoc" data-path="docs/guide.md#cursor-wake">${escapeHtml(t('ext.handoffSettings.wake.guide', 'Wake guide'))}</a></p>
         </div>` : ''}
         <div class="addon" id="cloudflare">
           <h3 class="sub">${escapeHtml(t('ext.handoffSettings.cloud.title', 'Cloudflare quick tunnel'))}</h3>
           <p class="hint">${escapeHtml(t('ext.handoffSettings.cloud.lead', 'Public HTTPS link without opening your router or installing VPN on the phone.'))}</p>
           ${cloudAbout}
           ${statusLine(tunnelTone(state), tunnelStatusLabel(state, t))}
           ${state.tunnelUrl ? `<p class="hint">${t('ext.handoffSettings.cloud.urlHint', 'URL: {url} · /web_url in # General').replace('{url}', `<a href="#" class="lnk" data-action="openExternal" data-url="${escapeHtml(state.tunnelUrl)}">${escapeHtml(state.tunnelUrl)}</a>`)}</p>` : ''}
           <div class="act-list">${state.cloudflaredInstalled
             ? `${actBtn('startTunnel', '▶', t('ext.handoffSettings.cloud.start', 'Start'), 'ok')}${actBtn('stopTunnel', '■', t('ext.handoffSettings.cloud.stop', 'Stop'), 'bad')}${actBtn('uninstallCloudflared', '🗑', t('ext.handoffSettings.cloud.uninstall', 'Remove cloudflared'), 'bad')}`
             : actBtn('installCloudflared', '▶', t('ext.handoffSettings.cloud.install', 'Download & install cloudflared'), 'ok')}
             ${actBtn('refreshAddons', '↻', t('web.common.refreshStatus', 'Refresh status'))}</div>
           <label class="ck${state.cloudflaredInstalled ? '' : ' off'}"><input type="checkbox" id="tunnelAutostart" ${state.tunnelAutostartEnabled ? 'checked' : ''} ${state.cloudflaredInstalled ? '' : 'disabled'} /><span>${escapeHtml(t('ext.handoffSettings.cloud.autostart', 'Start tunnel when server starts'))}</span></label>
           <p class="hint"><a href="#" class="lnk" data-action="openDoc" data-path="docs/guide.md#cloudflare">${escapeHtml(t('ext.handoffSettings.cloud.guide', 'Cloudflare guide'))}</a></p>
         </div>
       </div>`),
  ].join('');

  return /*html*/ `<!DOCTYPE html>
<html lang="${state.locale}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(t('ext.handoffSettings.title', 'Handoff settings'))}</title>
  <style>
    :root {
      --fg: var(--vscode-foreground);
      --muted: var(--vscode-descriptionForeground);
      --bg: var(--vscode-editor-background);
      --panel: var(--vscode-sideBar-background, var(--vscode-editor-background));
      --border: var(--vscode-panel-border, var(--vscode-widget-border, #444));
      --ok: var(--vscode-testing-iconPassed, #89d185);
      --warn: var(--vscode-editorWarning-foreground, #cca700);
      --bad: var(--vscode-errorForeground, #f48771);
      --hover: var(--vscode-list-hoverBackground);
      --link: var(--vscode-textLink-foreground);
      --btn: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --mono: var(--vscode-editor-font-family, ui-monospace, monospace);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); }

    body {
      font-family: var(--vscode-font-family, system-ui, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--fg);
      background: var(--bg);
      min-height: 100vh;
      line-height: 1.4;
    }

    .shell {
      display: grid;
      grid-template-columns: 200px 1fr;
      max-width: 920px; margin: 0 auto;
      min-height: 100vh;
    }
    @media (max-width: 680px) {
      .shell { grid-template-columns: 1fr; }
      .rail { position: static; border-right: none; border-bottom: 1px solid var(--border); flex-direction: row; flex-wrap: wrap; gap: 4px; padding: 12px 16px; height: auto; }
      .rail-a { padding: 6px 10px; }
    }

    .rail {
      position: sticky; top: 0; align-self: start;
      height: 100vh; padding: 20px 12px 20px 16px;
      border-right: 1px solid var(--border);
      background: var(--panel);
      display: flex; flex-direction: column; gap: 2px;
    }
    .rail-brand {
      font-size: 13px; font-weight: 600;
      color: var(--fg); margin-bottom: 12px; padding: 0 8px;
    }
    .rail-a {
      display: block; padding: 6px 10px; border-radius: 4px;
      color: var(--muted); text-decoration: none; font-size: 12px;
      border-left: 2px solid transparent;
    }
    .rail-a:hover { color: var(--fg); background: var(--hover); }
    .rail-a.on { color: var(--fg); border-left-color: var(--link); background: var(--hover); }

    .main { padding: 20px 20px 40px; }

    .card {
      margin-bottom: 20px; padding: 16px 18px;
      background: var(--panel);
      border: 1px solid var(--border); border-radius: 4px;
    }
    .card-h {
      font-size: 18px; font-weight: 600;
      margin-bottom: 12px; color: var(--fg);
    }
    .sub { font-size: 13px; font-weight: 600; margin-bottom: 8px; color: var(--fg); }
    .lead { line-height: 1.5; color: var(--muted); margin-bottom: 10px; }
    .hint { font-size: 11px; color: var(--muted); line-height: 1.45; margin-top: 8px; }
    .flare.warn {
      padding: 8px 10px; margin-bottom: 10px; font-size: 12px;
      border-left: 3px solid var(--warn); color: var(--warn);
      background: color-mix(in srgb, var(--warn) 12%, transparent);
    }

    .endpoint {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 12px; margin: 10px 0 14px;
      background: var(--input-bg); border: 1px solid var(--border); border-radius: 2px;
    }
    .endpoint-url {
      flex: 1; min-width: 0;
      font-family: var(--mono); font-size: 12px; color: var(--fg);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }

    .cfg { border-top: 1px solid var(--border); }
    .cfg-block { padding: 10px 0; border-bottom: 1px solid var(--border); }
    .cfg-block .cfg-lbl { margin-bottom: 4px; }
    .cfg-intro { margin: 0 0 8px; }
    .addon .ticks { margin: 6px 0 10px; }
    .bind-seg { display: flex; border: 1px solid var(--border); border-radius: 2px; overflow: hidden; }
    .bind-opt {
      flex: 1; padding: 7px 8px; border: none; border-right: 1px solid var(--border);
      background: transparent; color: var(--muted);
      font: inherit; font-size: 12px; cursor: pointer; text-align: center;
    }
    .bind-opt:last-child { border-right: none; }
    .bind-opt:hover { background: var(--hover); color: var(--fg); }
    .bind-opt.on { background: var(--btn); color: var(--btn-fg); font-weight: 600; }
    .cfg-row {
      display: grid; grid-template-columns: minmax(100px, 30%) 1fr;
      gap: 10px 14px; align-items: center; padding: 10px 0;
      border-bottom: 1px solid var(--border);
    }
    .cfg-lbl { font-size: 12px; color: var(--muted); line-height: 1.35; }
    .cfg-ctl { min-width: 0; }
    .cfg-sel, .cfg-in {
      width: 100%; padding: 6px 8px;
      border: 1px solid var(--border); border-radius: 2px;
      background: var(--input-bg); color: var(--input-fg);
      font: inherit; font-size: 13px;
    }
    .cfg-in { font-family: var(--mono); }
    .cfg-sel:focus, .cfg-in:focus { outline: 1px solid var(--link); outline-offset: -1px; }
    .pw-row { display: flex; gap: 6px; align-items: center; }
    .pw-row .cfg-in { flex: 1; min-width: 0; }
    .mini {
      font: inherit; font-size: 12px; padding: 5px 9px; flex-shrink: 0;
      border: 1px solid var(--border); border-radius: 2px;
      background: var(--input-bg); color: var(--fg); cursor: pointer;
    }
    .mini:hover { background: var(--hover); }
    .save.mini { background: var(--btn); color: var(--btn-fg); border: none; }
    .save.mini:hover { filter: brightness(1.08); }

    .field { display: block; margin: 10px 0; }
    .field span {
      display: block; font-size: 11px; color: var(--muted); margin-bottom: 4px;
    }
    .field input {
      width: 100%; padding: 6px 8px;
      border: 1px solid var(--border); border-radius: 2px;
      background: var(--input-bg); color: var(--input-fg);
      font: inherit; font-size: 13px; font-family: var(--mono);
    }
    .field input:focus { outline: 1px solid var(--link); outline-offset: -1px; }

    .beacon {
      font-family: var(--mono); font-size: 12px; padding: 8px 10px; margin: 8px 0;
      background: var(--input-bg); border: 1px solid var(--border);
      border-radius: 2px; word-break: break-all; color: var(--fg);
    }
    .beacon.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, var(--border)); }
    .beacon.code { display: block; }

    .puck {
      display: inline-flex; border: 1px solid var(--border); border-radius: 4px; overflow: hidden;
    }
    .puck-side {
      padding: 8px 16px; cursor: pointer; font-size: 12px; font-weight: 600;
      color: var(--muted); background: transparent;
    }
    .puck-side.on { color: var(--btn-fg); background: var(--btn); }
    .puck-side input { position: absolute; opacity: 0; pointer-events: none; }
    .puck-bg { display: none; }

    .tg-flow { margin-top: 6px; }
    .tg-step {
      display: grid; grid-template-columns: 28px 1fr; gap: 10px;
      padding: 12px 0; border-bottom: 1px solid var(--border);
    }
    .tg-step:last-child { border-bottom: none; }
    .tg-n {
      width: 24px; height: 24px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-family: var(--mono); font-size: 10px; font-weight: 600;
      border: 1px solid var(--border); color: var(--muted);
    }
    .tg-step.done .tg-n { border-color: var(--ok); color: var(--ok); }
    .tg-body h3 { font-size: 13px; font-weight: 600; margin-bottom: 6px; }
    .tg-transport { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border); }
    .tg-foot { margin-top: 12px; }
    .ticks { list-style: none; }
    .ticks li { padding: 4px 0 4px 14px; position: relative; color: var(--muted); line-height: 1.45; }
    .ticks li::before { content: '·'; position: absolute; left: 2px; color: var(--fg); }

    .addon-grid { display: grid; gap: 12px; }
    @media (min-width: 560px) { .addon-grid { grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); } }
    .addon {
      padding: 12px; border-radius: 4px;
      border: 1px solid var(--border); background: var(--panel);
    }

    .status-line { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: var(--muted); opacity: .55; }
    .dot.ok { background: var(--ok); opacity: 1; }
    .dot.warn { background: var(--warn); opacity: 1; }
    .dot.bad { background: var(--bad); opacity: 1; }
    .val.ok { color: var(--ok); }
    .val.warn { color: var(--warn); }
    .val.bad { color: var(--bad); }
    .val.muted { color: var(--muted); }

    .act-list { display: flex; flex-direction: column; gap: 0; margin: 8px 0; border-top: 1px solid var(--border); }
    .act {
      display: flex; align-items: center; gap: 10px; width: 100%;
      padding: 6px 4px; border: none; background: transparent;
      color: inherit; font: inherit; text-align: left; cursor: pointer;
    }
    .act:hover { background: var(--hover); }
    .act:disabled { opacity: .4; cursor: not-allowed; }
    .act-ico { width: 16px; text-align: center; font-size: 12px; color: var(--muted); flex-shrink: 0; }
    .act-lbl { color: var(--fg); font-size: 13px; }
    .act.tone-ok .act-ico { color: var(--ok); }
    .act.tone-warn .act-ico { color: var(--warn); }
    .act.tone-bad .act-ico { color: var(--bad); }

    .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; align-items: center; }
    .save {
      font: inherit; font-size: 12px; padding: 6px 14px; margin-top: 8px;
      border: none; border-radius: 2px; cursor: pointer;
      background: var(--btn); color: var(--btn-fg);
    }
    .save:hover { filter: brightness(1.08); }

    .impl-sw { display: flex; margin: 10px 0; border: 1px solid var(--border); border-radius: 2px; overflow: hidden; }
    .impl-pick {
      flex: 1; padding: 8px; border: none; background: transparent;
      color: var(--muted); font: inherit; font-size: 12px; cursor: pointer;
    }
    .impl-pick.on { background: var(--hover); color: var(--fg); font-weight: 600; }

    .ck { display: flex; gap: 8px; margin-top: 10px; font-size: 11px; color: var(--muted); cursor: pointer; }
    .ck.off { opacity: .4; pointer-events: none; }

    a.lnk { color: var(--link); text-decoration: none; }
    a.lnk:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="shell">
    <nav class="rail" aria-label="${escapeHtml(t('ext.handoffSettings.nav.label', 'Sections'))}">
      <div class="rail-brand">${escapeHtml(t('ext.handoffSettings.ui.brand', 'Handoff'))}</div>
      ${navHtml}
    </nav>
    <div class="main">
      ${sections}
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    function sendMsg(m) { vscode.postMessage(m); }

    const railLinks = document.querySelectorAll('.rail-a');
    const cards = document.querySelectorAll('.card');
    function setActive(id) {
      railLinks.forEach(a => a.classList.toggle('on', a.dataset.jump === id));
    }
    railLinks.forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        document.getElementById(a.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setActive(a.dataset.jump);
        vscode.setState({ section: a.dataset.jump });
      });
    });
    if (cards.length && 'IntersectionObserver' in window) {
      const obs = new IntersectionObserver(entries => {
        for (const e of entries) {
          if (e.isIntersecting) setActive(e.target.id);
        }
      }, { rootMargin: '-30% 0px -55% 0px', threshold: 0 });
      cards.forEach(c => obs.observe(c));
    }
    const saved = vscode.getState()?.section;
    if (saved) setActive(saved);

    document.querySelectorAll('[data-action="openExternal"]').forEach(el => {
      el.addEventListener('click', e => { e.preventDefault(); sendMsg({ type: 'openExternal', url: el.dataset.url }); });
    });
    document.querySelectorAll('[data-action="openDoc"]').forEach(el => {
      el.addEventListener('click', e => { e.preventDefault(); sendMsg({ type: 'openDoc', path: el.dataset.path }); });
    });

    document.querySelectorAll('input[name="locale"]').forEach(r => {
      r.addEventListener('change', () => {
        document.querySelectorAll('.puck-side').forEach(s => s.classList.toggle('on', s.querySelector('input')?.checked));
        sendMsg({ type: 'setLocale', locale: r.value });
      });
    });
    document.querySelectorAll('.puck-side').forEach(side => {
      side.addEventListener('click', () => side.querySelector('input')?.click());
    });

    const netSelect = document.getElementById('netModeSelect');
    const netHint = document.getElementById('netHint');
    const customWrap = document.getElementById('customAddrWrap');
    const SERVER_PORT = ${state.serverPort};
    const PREVIEW_YOUR_IP = '<your-ip>';
    function endpointHost(mode) {
      if (mode === 'localhost') return '127.0.0.1';
      if (mode === 'lan') return PREVIEW_YOUR_IP;
      return document.getElementById('customAddress')?.value?.trim() || PREVIEW_YOUR_IP;
    }
    function updateEndpoint(mode) {
      const m = mode || netSelect?.value || 'localhost';
      const el = document.getElementById('endpointUrl');
      if (el) el.textContent = 'http://' + endpointHost(m) + ':' + SERVER_PORT;
      const local = m === 'localhost';
      const pw = document.getElementById('passwordInput')?.value?.trim();
      const dot = document.getElementById('endpointDot');
      if (dot) dot.className = 'dot ' + (local ? 'muted' : pw ? 'ok' : 'warn');
    }
    function setNetMode(mode) {
      if (netSelect) netSelect.value = mode;
      document.querySelectorAll('.bind-opt').forEach(b => b.classList.toggle('on', b.dataset.net === mode));
      const opt = netSelect?.querySelector('option[value="' + mode + '"]');
      if (netHint && opt) netHint.textContent = opt.dataset.hint || '';
      if (customWrap) customWrap.style.display = mode === 'custom' ? '' : 'none';
      updateEndpoint(mode);
    }
    document.querySelectorAll('.bind-opt').forEach(b => b.addEventListener('click', () => setNetMode(b.dataset.net)));
    document.getElementById('customAddress')?.addEventListener('input', () => updateEndpoint());
    document.getElementById('passwordInput')?.addEventListener('input', () => updateEndpoint());

    document.getElementById('saveNetworking')?.addEventListener('click', () => {
      const mode = netSelect?.value || 'localhost';
      const msg = { type: 'setNetworking', mode };
      if (mode === 'custom') msg.address = document.getElementById('customAddress')?.value || '';
      sendMsg(msg);
      setTimeout(() => sendMsg({ type: 'restartServer' }), 500);
    });
    document.getElementById('copyEndpoint')?.addEventListener('click', () => {
      const url = document.getElementById('endpointUrl')?.textContent?.trim();
      if (url) navigator.clipboard.writeText(url).catch(() => {});
    });
    document.getElementById('copyPassword')?.addEventListener('click', () => {
      const pw = document.getElementById('passwordInput')?.value;
      if (pw) navigator.clipboard.writeText(pw).then(() => sendMsg({ type: 'copyPassword' })).catch(() => sendMsg({ type: 'copyPassword' }));
      else sendMsg({ type: 'copyPassword' });
    });
    document.getElementById('savePassword')?.addEventListener('click', () => {
      sendMsg({ type: 'savePassword', password: document.getElementById('passwordInput')?.value || '' });
    });
    document.getElementById('saveToken')?.addEventListener('click', () => {
      const token = document.getElementById('botTokenInput')?.value;
      if (token) sendMsg({ type: 'saveTelegramToken', token });
    });
    document.getElementById('saveAllowedUsers')?.addEventListener('click', () => {
      sendMsg({ type: 'saveAllowedUsers', allowedUsers: document.getElementById('allowedUsersInput')?.value || '' });
    });
    document.getElementById('copyRegister')?.addEventListener('click', () => {
      const c = document.querySelector('.code');
      if (c) navigator.clipboard.writeText(c.textContent.trim());
    });

    const tgImplSelect = document.getElementById('tgImplSelect');
    document.querySelectorAll('.impl-pick').forEach(p => p.addEventListener('click', () => {
      if (tgImplSelect) tgImplSelect.value = p.dataset.impl;
      document.querySelectorAll('.impl-pick').forEach(x => x.classList.toggle('on', x.dataset.impl === p.dataset.impl));
    }));
    document.getElementById('saveTgImpl')?.addEventListener('click', () => {
      const impl = tgImplSelect?.value;
      if (impl) { sendMsg({ type: 'setTelegramImpl', impl }); setTimeout(() => sendMsg({ type: 'restartServer' }), 500); }
    });

    document.getElementById('installWake')?.addEventListener('click', () => sendMsg({ type: 'installWake' }));
    document.getElementById('uninstallWake')?.addEventListener('click', () => sendMsg({ type: 'uninstallWake' }));
    document.getElementById('restartWake')?.addEventListener('click', () => sendMsg({ type: 'restartWake' }));
    document.getElementById('pauseWake')?.addEventListener('click', () => sendMsg({ type: 'pauseWake' }));
    document.getElementById('resumeWake')?.addEventListener('click', () => sendMsg({ type: 'resumeWake' }));
    document.getElementById('wakeStartup')?.addEventListener('change', e => sendMsg({ type: 'setWakeStartup', enabled: e.target.checked }));
    document.getElementById('installCloudflared')?.addEventListener('click', () => sendMsg({ type: 'installCloudflared' }));
    document.getElementById('uninstallCloudflared')?.addEventListener('click', () => sendMsg({ type: 'uninstallCloudflared' }));
    document.getElementById('startTunnel')?.addEventListener('click', () => sendMsg({ type: 'startTunnel' }));
    document.getElementById('stopTunnel')?.addEventListener('click', () => sendMsg({ type: 'stopTunnel' }));
    document.getElementById('tunnelAutostart')?.addEventListener('change', e => sendMsg({ type: 'setTunnelAutostart', enabled: e.target.checked }));
    document.getElementById('refreshAddons')?.addEventListener('click', () => sendMsg({ type: 'refresh' }));
    const startT = document.getElementById('startTunnel');
    const stopT = document.getElementById('stopTunnel');
    if (startT) startT.disabled = ${JSON.stringify(state.tunnelRunning)};
    if (stopT) stopT.disabled = ${JSON.stringify(!state.tunnelRunning)};
  </script>
</body>
</html>`;
}
