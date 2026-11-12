// Grounded Web Search Agent - Client Application
(function () {
  // 1. User Identity & State
  let userId = localStorage.getItem('agent_user_id');
  if (!userId) {
    userId = 'usr_' + Math.random().toString(36).slice(2, 9);
    localStorage.setItem('agent_user_id', userId);
  }

  let activeConversationId = localStorage.getItem('agent_active_conv_id') || null;
  const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  // Elements
  const clientTzEl = document.getElementById('client-tz');
  const clientDateEl = document.getElementById('client-date');
  const conversationsListEl = document.getElementById('conversations-list');
  const chatMessagesEl = document.getElementById('chat-messages');
  const chatFormEl = document.getElementById('chat-form');
  const userInputEl = document.getElementById('user-input');
  const sendBtnEl = document.getElementById('send-btn');
  const newChatBtn = document.getElementById('new-chat-btn');
  const modelTagEl = document.getElementById('model-tag');
  const systemStatusEl = document.getElementById('system-status');
  const convTitleEl = document.getElementById('conv-title');

  // Display initial meta
  clientTzEl.textContent = userTimezone;
  const now = new Date();
  clientDateEl.textContent = `${now.toISOString().slice(0, 10)} (${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][now.getDay()]})`;

  // Fetch health
  fetch('/api/health')
    .then(r => r.json())
    .then(data => {
      modelTagEl.textContent = `Model: ${data.model}`;
    })
    .catch(() => {
      modelTagEl.textContent = 'Model: gpt-4o-mini';
    });

  // 2. Load conversations
  async function loadConversations() {
    try {
      const res = await fetch(`/api/conversations?userId=${encodeURIComponent(userId)}`);
      const convs = await res.json();
      renderConversationsList(convs);

      if (activeConversationId) {
        const found = convs.find(c => c.id === activeConversationId);
        if (found) {
          convTitleEl.textContent = found.title;
          loadConversationHistory(activeConversationId);
        } else {
          startNewChat(false);
        }
      }
    } catch (err) {
      console.error('Failed to load conversations:', err);
    }
  }

  function renderConversationsList(convs) {
    conversationsListEl.innerHTML = '';
    if (convs.length === 0) {
      conversationsListEl.innerHTML = '<div class="empty-state">No saved conversations yet.</div>';
      return;
    }

    convs.forEach(c => {
      const item = document.createElement('div');
      item.className = `conv-item ${c.id === activeConversationId ? 'active' : ''}`;
      item.innerHTML = `
        <div class="conv-item-title">${escapeHtml(c.title || 'Conversation')}</div>
        <div class="conv-item-date">${c.created_at.slice(0, 10)}</div>
      `;
      item.addEventListener('click', () => switchConversation(c.id, c.title));
      conversationsListEl.appendChild(item);
    });
  }

  async function loadConversationHistory(convId) {
    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(convId)}/messages`);
      const msgs = await res.json();
      chatMessagesEl.innerHTML = '';
      if (msgs.length === 0) {
        showWelcomeBanner();
        return;
      }
      msgs.forEach(m => {
        appendMessageBubble(m.role, m.content, m.created_at, m.sources);
      });
      scrollToBottom();
    } catch (err) {
      console.error('Failed to load messages:', err);
    }
  }

  function switchConversation(id, title) {
    activeConversationId = id;
    localStorage.setItem('agent_active_conv_id', id);
    convTitleEl.textContent = title;
    document.querySelectorAll('.conv-item').forEach(el => el.classList.remove('active'));
    loadConversationHistory(id);
    loadConversations();
  }

  function startNewChat(refresh = true) {
    activeConversationId = null;
    localStorage.removeItem('agent_active_conv_id');
    convTitleEl.textContent = 'New Conversation';
    chatMessagesEl.innerHTML = '';
    showWelcomeBanner();
    if (refresh) loadConversations();
  }

  newChatBtn.addEventListener('click', () => startNewChat());

  function showWelcomeBanner() {
    const banner = document.createElement('div');
    banner.className = 'welcome-banner';
    banner.innerHTML = `
      <h3>Architecturally Grounded Web Search Agent</h3>
      <p>
        Equipped with <strong>exactly one tool</strong> (web search), persistent timestamped memory,
        and deterministic date resolution in code. Try asking:
      </p>
      <div class="prompt-chips">
        <button class="chip" data-prompt="On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?">
          CRM shortlisted on Monday
        </button>
        <button class="chip" data-prompt="What did I ask you on 3 November? Is your answer still correct today?">
          Query from 3 November
        </button>
        <button class="chip" data-prompt="Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?">
          Postgres hosting changes
        </button>
        <button class="chip" data-prompt="What did I ask on 14 October?">
          Honesty check (missing record)
        </button>
      </div>
    `;
    chatMessagesEl.appendChild(banner);
    bindPromptChips();
  }

  function bindPromptChips() {
    document.querySelectorAll('.chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const text = btn.getAttribute('data-prompt');
        if (text) {
          userInputEl.value = text;
          chatFormEl.dispatchEvent(new Event('submit'));
        }
      });
    });
  }

  // 3. Message rendering
  function appendMessageBubble(role, content, timestamp, sources) {
    const row = document.createElement('div');
    row.className = `message-row ${role}`;

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';

    if (role === 'assistant') {
      bubble.innerHTML = window.marked ? window.marked.parse(content) : escapeHtml(content);
      if (sources && sources.length > 0) {
        appendSourcesBlock(bubble, sources);
      }
    } else {
      bubble.textContent = content;
    }

    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const timeStr = timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    meta.textContent = `${role === 'user' ? 'You' : 'Agent'} · ${timeStr}`;

    row.appendChild(bubble);
    row.appendChild(meta);
    chatMessagesEl.appendChild(row);
    scrollToBottom();
    return bubble;
  }

  function appendSourcesBlock(container, sources) {
    const card = document.createElement('div');
    card.className = 'sources-card';
    card.innerHTML = `<div class="sources-header"><span>🔗</span> Sources Cited (${sources.length})</div>`;
    const grid = document.createElement('div');
    grid.className = 'sources-grid';

    sources.forEach((s, idx) => {
      const a = document.createElement('a');
      a.className = 'source-item';
      a.href = s.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.innerHTML = `
        <div class="source-domain">[${idx + 1}] ${escapeHtml(s.domain || 'web')}</div>
        <div class="source-title" title="${escapeHtml(s.title)}">${escapeHtml(s.title || s.url)}</div>
      `;
      grid.appendChild(a);
    });

    card.appendChild(grid);
    container.appendChild(card);
  }

  function scrollToBottom() {
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // 4. Form submission & SSE Streaming
  chatFormEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = userInputEl.value.trim();
    if (!message) return;

    userInputEl.value = '';
    userInputEl.style.height = 'auto';

    // Remove welcome banner if present
    const banner = chatMessagesEl.querySelector('.welcome-banner');
    if (banner) banner.remove();

    // Render User message bubble
    appendMessageBubble('user', message, new Date().toISOString());

    // Create Assistant Row and Elements
    const row = document.createElement('div');
    row.className = 'message-row assistant';

    // Status pill
    const statusPill = document.createElement('div');
    statusPill.className = 'tool-pill';
    statusPill.textContent = 'Thinking...';
    row.appendChild(statusPill);

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    row.appendChild(bubble);

    const meta = document.createElement('div');
    meta.className = 'message-meta';
    meta.textContent = `Agent · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    row.appendChild(meta);

    chatMessagesEl.appendChild(row);
    scrollToBottom();

    systemStatusEl.className = 'status-indicator busy';
    systemStatusEl.textContent = 'Processing...';
    sendBtnEl.disabled = true;

    let assistantText = '';
    let accumulatedSources = [];

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          conversationId: activeConversationId,
          userId,
          timezone: userTimezone,
        }),
      });

      if (!response.ok) {
        throw new Error(`Server returned HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.replace('data: ', '').trim();
          if (!jsonStr) continue;

          try {
            const event = JSON.parse(jsonStr);

            if (event.type === 'init') {
              if (!activeConversationId) {
                activeConversationId = event.conversationId;
                localStorage.setItem('agent_active_conv_id', activeConversationId);
                loadConversations();
              }
            } else if (event.type === 'status') {
              statusPill.textContent = event.message;
            } else if (event.type === 'resolved_dates') {
              const datePill = document.createElement('div');
              datePill.className = 'resolved-dates-pill';
              datePill.innerHTML = `<span>📅</span> ${event.dates.map(d => `"${d.expression}" &rarr; <strong>${d.isoDate}</strong> (${d.weekday})`).join(', ')}`;
              row.insertBefore(datePill, bubble);
            } else if (event.type === 'tool_call') {
              statusPill.innerHTML = `<span>🔍</span> Searching ${event.queries.length} queries in parallel: <em>${escapeHtml(event.queries.join(', '))}</em>`;
            } else if (event.type === 'tool_result') {
              statusPill.textContent = `Retrieved ${event.count} verified sources. Synthesizing answer...`;
            } else if (event.type === 'text_delta') {
              assistantText += event.delta;
              bubble.innerHTML = window.marked ? window.marked.parse(assistantText) : escapeHtml(assistantText);
              scrollToBottom();
            } else if (event.type === 'finish') {
              assistantText = event.fullText;
              accumulatedSources = event.sources || [];
              bubble.innerHTML = window.marked ? window.marked.parse(assistantText) : escapeHtml(assistantText);
              if (accumulatedSources.length > 0) {
                appendSourcesBlock(bubble, accumulatedSources);
              }
              statusPill.remove();
              scrollToBottom();
            } else if (event.type === 'error') {
              statusPill.textContent = `Error: ${event.error}`;
              statusPill.style.borderColor = '#f87171';
              statusPill.style.color = '#f87171';
              bubble.innerHTML = `<div style="color: #f87171; padding: 6px 0;"><strong>Error:</strong> ${escapeHtml(event.error)}</div>`;
            }
          } catch (e) {
            console.error('Error parsing SSE event:', e);
          }
        }
      }
    } catch (err) {
      statusPill.textContent = `Error: ${err.message}`;
      statusPill.style.color = '#f87171';
      bubble.innerHTML = `<div style="color: #f87171; padding: 6px 0;"><strong>Error:</strong> ${escapeHtml(err.message)}</div>`;
    } finally {
      systemStatusEl.className = 'status-indicator ready';
      systemStatusEl.textContent = 'Ready';
      sendBtnEl.disabled = false;
      loadConversations();
    }
  });

  // Auto-resize textarea
  userInputEl.addEventListener('input', () => {
    userInputEl.style.height = 'auto';
    userInputEl.style.height = Math.min(userInputEl.scrollHeight, 140) + 'px';
  });

  // Initialize
  loadConversations();
  bindPromptChips();
})();

