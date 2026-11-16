// apply the saved theme and language before first paint to avoid a flash
try {
  var t = localStorage.getItem('pd-theme');
  if (!t) t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
  var lang = localStorage.getItem('pd-lang');
  if (lang !== 'fa' && lang !== 'en') lang = 'en';
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'fa' ? 'rtl' : 'ltr';
  document.title = lang === 'fa' ? 'داشبورد پرامپت' : 'Prompt Dashboard';
} catch (e) {}
