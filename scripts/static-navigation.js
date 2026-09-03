(() => {
  const routes = {
    'index.html': [
      { text: '立即登录', target: 'home.html' },
    ],
    'home.html': [
      { text: '进出申请', target: 'out.html' },
      { text: '我的', target: 'records.html' },
    ],
    'out.html': [
      { text: '出入申请', target: 'apply.html', within: '.form-item' },
      { text: '我的申请', target: 'records.html', within: '.bottom-menu-item' },
    ],
    'apply.html': [
      { text: '我的申请', target: 'records.html', within: '.bottom-menu-item' },
      { text: '外出申请', target: 'out.html', within: '.bottom-menu-item' },
    ],
    'records.html': [
      { text: '外出申请', target: 'out.html', within: '.bottom-menu-item' },
    ],
    '步骤1登录.html': [
      { text: '立即登录', target: 'home.html' },
    ],
    '步骤2进入首页.html': [
      { text: '进出申请', target: 'out.html' },
      { text: '我的', target: 'records.html' },
    ],
    '步骤3点击进出申请进去外出申请.html': [
      { text: '出入申请', target: 'apply.html', within: '.form-item' },
      { text: '我的申请', target: 'records.html', within: '.bottom-menu-item' },
    ],
    '步骤4点击外出申请进入申请页.html': [
      { text: '我的申请', target: 'records.html', within: '.bottom-menu-item' },
      { text: '外出申请', target: 'out.html', within: '.bottom-menu-item' },
    ],
    '步骤3-5进入我的申请查看申请记录等.html': [
      { text: '外出申请', target: 'out.html', within: '.bottom-menu-item' },
    ],
  };

  const fileName = decodeURIComponent(location.pathname.split('/').pop() || '步骤1登录.html');
  const pageRoutes = routes[fileName] || [];

  function textOf(node) {
    return (node.textContent || '').replace(/\s+/g, '').trim();
  }

  function isInRouteScope(node, route) {
    return !route.within || Boolean(node.closest(route.within));
  }

  function closestRouteTarget(startNode) {
    for (const route of pageRoutes) {
      let node = startNode;
      while (node && node !== document.body) {
        if (node.nodeType === Node.ELEMENT_NODE && textOf(node) === route.text && isInRouteScope(node, route)) {
          return route.target;
        }
        node = node.parentElement;
      }
    }
    return null;
  }

  document.addEventListener('click', (event) => {
    const target = closestRouteTarget(event.target);
    if (!target) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const account = new URLSearchParams(location.search).get('account');
    const suffix = account ? `?account=${encodeURIComponent(account)}` : '';
    location.href = './' + encodeURI(target) + suffix;
  }, true);
})();
