// Si falla la descarga de algún módulo del juego, avisa en la pantalla de carga en vez de quedarse esperando.
// (Archivo aparte y no un atributo onerror: la política de seguridad de la página no permite código en línea.)
window.addEventListener('error', function (e) {
  var el = e.target;
  if (!el || el.tagName !== 'SCRIPT') return;
  var text = document.querySelector('.loading__text');
  if (text) text.textContent = 'No se pudo cargar el simulador. Comprueba la conexión y recarga la página.';
}, true);
