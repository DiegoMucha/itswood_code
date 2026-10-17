// Priora landing page
// Código en inglés (variables, funciones); el copy visible vive en assets/content/landing.es.js.


// ============================================
// MOBILE MENU
// ============================================

var hamburgerButton = document.getElementById('hamburger');
var navMenu = document.getElementById('nav-menu');

function setMobileMenu(isOpen) {
    navMenu.classList.toggle('open', isOpen);
    hamburgerButton.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
}

if (hamburgerButton && navMenu) {
    hamburgerButton.addEventListener('click', function () {
        setMobileMenu(!navMenu.classList.contains('open'));
    });

    // Cualquier enlace del menú lo cierra al navegar
    navMenu.addEventListener('click', function (event) {
        if (event.target.closest('a')) setMobileMenu(false);
    });

    document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && navMenu.classList.contains('open')) {
            setMobileMenu(false);
            hamburgerButton.focus();
        }
    });
}


// ============================================
// NAVBAR: vidrio más opaco cuando la página ya se desplazó
// ============================================

var navbar = document.getElementById('navbar');

function updateNavbarState() {
    navbar.classList.toggle('is-scrolled', window.scrollY > 8);
}

if (navbar) {
    updateNavbarState();
    window.addEventListener('scroll', updateNavbarState, { passive: true });
}
