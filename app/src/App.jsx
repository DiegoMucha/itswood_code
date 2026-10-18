import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppProvider } from './context/AppContext.jsx';
import Layout from './components/Layout.jsx';

const Inicio = lazy(() => import('./pages/Inicio.jsx'));
const Pedidos = lazy(() => import('./pages/Pedidos.jsx'));
const Mermin = lazy(() => import('./pages/Mermin.jsx'));
const Fidelizacion = lazy(() => import('./pages/Fidelizacion.jsx'));
const Catalogo = lazy(() => import('./pages/Catalogo.jsx'));
const Datos = lazy(() => import('./pages/Datos.jsx'));
const Ajustes = lazy(() => import('./pages/Ajustes.jsx'));

export default function App() {
  return (
    <AppProvider>
      <Suspense fallback={<p className="muted" style={{ padding: '2rem' }}>Cargando…</p>}>
        <Routes>
          <Route path="/" element={<Navigate to="/app" replace />} />
          <Route path="/app" element={<Layout />}>
            <Route index element={<Inicio />} />
            <Route path="pedidos" element={<Pedidos />} />
            <Route path="mermin" element={<Mermin />} />
            <Route path="fidelizacion" element={<Fidelizacion />} />
            <Route path="catalogo" element={<Catalogo />} />
            <Route path="datos" element={<Datos />} />
            <Route path="ajustes" element={<Ajustes />} />
          </Route>
          <Route path="*" element={<Navigate to="/app" replace />} />
        </Routes>
      </Suspense>
    </AppProvider>
  );
}
