(function () {
  const topbar = document.querySelector('.topbar');
  const menuToggle = document.getElementById('menuToggle');
  const menu = document.getElementById('menuNav');

  function setMenu(open) {
    if (!menu || !menuToggle) {
      return;
    }
    menu.classList.toggle('is-open', open);
    menuToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  if (menuToggle && menu) {
    menuToggle.addEventListener('click', function () {
      const isOpen = menu.classList.contains('is-open');
      setMenu(!isOpen);
    });

    menu.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () {
        setMenu(false);
      });
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        setMenu(false);
      }
    });

    document.addEventListener('click', function (event) {
      if (!menu.contains(event.target) && !menuToggle.contains(event.target)) {
        setMenu(false);
      }
    });
  }

  function onScroll() {
    if (!topbar) {
      return;
    }
    topbar.classList.toggle('topbar--scrolled', window.scrollY > 8);
  }

  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  const revealElements = Array.from(document.querySelectorAll('[data-reveal]'));
  if ('IntersectionObserver' in window && revealElements.length > 0) {
    const observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
        });
      },
      {
        threshold: 0.16,
        rootMargin: '0px 0px -24px 0px',
      }
    );

    revealElements.forEach(function (item) {
      observer.observe(item);
    });
  } else {
    revealElements.forEach(function (item) {
      item.classList.add('is-visible');
    });
  }
})();