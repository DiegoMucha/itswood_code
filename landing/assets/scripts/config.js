// Priora landing page — configuración. Único lugar para las URLs del sitio y de la app.

window.PRIORA_CONFIG = {
    // URL base de la app, sin barra final (p. ej. 'https://priora-app.vercel.app').
    // "Quiero Priora" lleva a APP_URL + '/app' y "Ver demo" a APP_URL + '/app/mermin'.
    // Mientras sea '#': se ocultan la sección Demo y los botones "Ver demo",
    // y "Quiero Priora" lleva al cierre de la página.
    APP_URL: '#',

    // URL pública de esta landing en Vercel, sin barra final. Se usa para og:url y para
    // volver absoluta la og:image.
    // TODO: completar tras el primer despliegue (p. ej. 'https://<proyecto>.vercel.app').
    SITE_URL: ''

    // Ya no se usa: el hero dibuja su curva de luz en SVG/CSS (index.html).
    // Escena de Spline anterior, por si se quiere volver a ella:
    // SPLINE_URL: 'https://my.spline.design/claritystream-Txg1N81Wzit6iC1CdjTIFz36/'
};
