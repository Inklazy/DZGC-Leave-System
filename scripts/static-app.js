(() => {
  const ACCOUNT_COOKIE = 'leave-account';
  const TREND_CODES = new Map([
    ['申请离校', '1'],
    ['申请回宿', '2'],
    ['申请宿舍免查寝', '3'],
    ['申请上课免考勤', '4'],
  ]);
  const REASONS = ['事假', '其他'];
  const REASON_CODES = new Map([
    ['事假', '7'],
    ['其他', '8'],
  ]);

  function text(node) {
    return (node.textContent || '').replace(/\s+/g, '').trim();
  }

  function rawText(node) {
    return (node.textContent || '').trim();
  }

  function toast(message) {
    let node = document.querySelector('#leave-static-toast');
    if (!node) {
      node = document.createElement('div');
      node.id = 'leave-static-toast';
      node.style.cssText = [
        'position:fixed',
        'left:50%',
        'top:45%',
        'transform:translate(-50%,-50%)',
        'max-width:80vw',
        'padding:12px 18px',
        'border-radius:6px',
        'background:rgba(0,0,0,.75)',
        'color:#fff',
        'font-size:14px',
        'line-height:20px',
        'text-align:center',
        'z-index:99999',
      ].join(';');
      document.body.appendChild(node);
    }

    node.textContent = message;
    node.style.display = 'block';
    clearTimeout(node.__timer);
    node.__timer = setTimeout(() => {
      node.style.display = 'none';
    }, 2200);
  }

  function accountHeaders() {
    const account = accountValue();
    const headers = {
      'content-type': 'application/json',
    };
    if (account) headers['x-leave-account'] = account;
    return headers;
  }

  function accountValue() {
    const queryAccount = new URLSearchParams(location.search).get('account');
    if (queryAccount) {
      return queryAccount;
    }

    const match = document.cookie.match(/(?:^|;\s*)leave-account=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  function pageName() {
    return decodeURIComponent(location.pathname.split('/').pop() || 'index.html');
  }

  function closestElement(startNode, selector) {
    let node = startNode;
    while (node && node !== document.body) {
      if (node.nodeType === Node.ELEMENT_NODE && node.matches?.(selector)) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  function setupLogin() {
    if (pageName() !== 'index.html' && pageName() !== '步骤1登录.html') return;

    const inputs = [...document.querySelectorAll('input.uni-input-input')].filter((input) => input.offsetParent !== null);
    const submit = document.querySelector('.submit-button');
    if (!submit) return;

    document.addEventListener('click', async (event) => {
      if (!closestElement(event.target, '.submit-button')) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();

      const account = inputs[0]?.value.trim();
      if (!account) {
        toast('请输入学号');
        return;
      }

      document.cookie = `${ACCOUNT_COOKIE}=${encodeURIComponent(account)}; path=/; max-age=31536000; SameSite=Lax`;
      toast('登录成功');
      setTimeout(() => {
        location.href = `./home.html?account=${encodeURIComponent(account)}`;
      }, 500);
    }, true);
  }

  function selectedTrends() {
    return [...document.querySelectorAll('.uni-data-checklist:not(.promise-check-box) .checklist-box.is--tag.is-checked')]
      .map((node) => text(node.querySelector('.checklist-text')))
      .filter(Boolean);
  }

  function setupApplyForm() {
    if (pageName() !== 'apply.html' && pageName() !== '步骤4点击外出申请进入申请页.html') return;

    const times = [...document.querySelectorAll('.uni-date__x-input')].slice(0, 2);
    times.forEach((node, index) => {
      node.setAttribute('contenteditable', 'true');
      node.style.outline = 'none';
      node.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          node.blur();
        }
      });
      if (!text(node) || text(node) === '请选择') {
        node.textContent = index === 0
          ? new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
          : '';
      }
    });

    const trendBoxes = [...document.querySelectorAll('.uni-data-checklist:not(.promise-check-box) .checklist-box.is--tag')];
    trendBoxes.forEach((box) => {
      box.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        box.classList.toggle('is-checked');
      });
    });

    const reasonNode = document.querySelector('.uni-data-tree .selected-area span');
    const reasonBox = document.querySelector('.uni-data-tree .input-value');
    let reasonIndex = 0;
    if (reasonBox && reasonNode) {
      reasonBox.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        reasonIndex = (reasonIndex + 1) % REASONS.length;
        reasonNode.textContent = REASONS[reasonIndex];
        reasonNode.classList.remove('placeholder');
      });
    }

    const description = document.querySelector('input[maxlength="20"].uni-input-input');
    const submit = [...document.querySelectorAll('uni-button')].find((button) => text(button) === '提交');
    if (!submit) return;
    submit.setAttribute('data-static-submit', 'ready');

    submit.classList.remove('u-button--disabled');
    document.addEventListener('click', async (event) => {
      if (!closestElement(event.target, '[data-static-submit]')) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const account = accountValue();
      if (!account) {
        toast('请先登录');
        return;
      }

      const startTime = rawText(times[0]);
      const endTime = rawText(times[1]);
      const reason = text(reasonNode);
      const trends = selectedTrends();
      const reasonText = (description?.value || '').trim();

      if (!startTime || !endTime) {
        toast('请填写开始和结束时间');
        return;
      }
      if (new Date(startTime.replace(/-/g, '/')) >= new Date(endTime.replace(/-/g, '/'))) {
        toast('结束时间必须晚于开始时间');
        return;
      }
      if (!reason) {
        toast('请选择进出事由');
        return;
      }
      if (!trends.length) {
        toast('请选择申请动向');
        return;
      }
      if (reasonText.length < 2) {
        toast('请输入请假事由');
        return;
      }

      const page = document.querySelector('.we-page');
      const payload = {
        formId: page?.getAttribute('formid') || '100017',
        businessNo: page?.getAttribute('businessno') || 'BM5017',
        subClient: page?.getAttribute('subclient') || 'apph5_internal_student',
        formVersion: 1,
        params: {
          flowRecords: [],
          gatewayTransitBeginTime: startTime,
          gatewayTransitEndTime: endTime,
          approvalTrendId: trends.map((label) => TREND_CODES.get(label)).filter(Boolean),
          gatewayTransitType: REASON_CODES.get(reason) || '8',
          shiyoumiaoshu: reasonText,
          benrenchengnuo: ['1'],
        },
      };

      submit.classList.add('u-button--disabled');
      try {
        const response = await fetch('/api/applications', {
          method: 'POST',
          headers: accountHeaders(),
          body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (!response.ok || !result.ok) {
          throw new Error(result.message || '提交失败');
        }
        toast('申请提交成功');
        setTimeout(() => {
          location.href = `./records.html?account=${encodeURIComponent(account)}`;
        }, 800);
      } catch (error) {
        toast(error.message || '提交失败');
      } finally {
        submit.classList.remove('u-button--disabled');
      }
    }, true);
  }

  function valueFromParams(record, label) {
    const item = (record.paramList || []).find((param) => param.label === label);
    return item?.value || '--';
  }

  function cloneRecord(record, template) {
    const source = template || document.querySelector('.record-row');
    const loadMore = document.querySelector('.we-load-more');
    if (!source || !loadMore) return;

    const node = source.cloneNode(true);
    node.setAttribute('data-submit-id', record.submitId || '');
    node.querySelector('.time span').textContent = record.title1 || '';
    node.querySelector('.record-row__header').textContent = record.title2 || '';

    const rows = [...node.querySelectorAll('.record-row__content__row')];
    const labels = ['表单', '学号', '班级', '开始时间', '结束时间', '进出事由', '申请动向'];
    rows.forEach((row, index) => {
      const label = labels[index];
      const valueNode = row.querySelector('.record-row__content__row__value');
      if (valueNode) valueNode.textContent = label ? valueFromParams(record, label) : '--';
    });

    loadMore.parentNode.insertBefore(node, loadMore);
  }

  async function setupRecords() {
    if (pageName() !== 'records.html' && pageName() !== '步骤3-5进入我的申请查看申请记录等.html') return;

    try {
      const response = await fetch('/api/records', { headers: accountHeaders() });
      const result = await response.json();
      if (!response.ok || !result.ok) return;
      renderRecords(result.records);
    } catch {
      // The saved page still shows its original records when the backend is unavailable.
    }
  }

  function renderRecords(records) {
    if (!records.length) return;

    const loadMore = document.querySelector('.we-load-more');
    if (!loadMore?.parentNode) return;

    const existingRecords = [...document.querySelectorAll('.record-row')]
      .filter((node) => !node.getAttribute('data-submit-id'));
    const template = document.querySelector('.record-row')?.cloneNode(true);
    existingRecords.forEach((node) => node.remove());
    records.forEach((record) => cloneRecord(record, template));
    existingRecords.forEach((node) => loadMore.parentNode.insertBefore(node, loadMore));
  }

  setupLogin();
  setupApplyForm();
  setupRecords();
})();
