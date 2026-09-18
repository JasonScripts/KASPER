import "@/App.css";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import { AuthProvider, useAuth } from "@/context/AuthContext";
import { LanguageProvider } from "@/i18n";
import Login from "@/pages/Login";
import Worker from "@/pages/Worker";
import Admin from "@/pages/Admin";
import { Loader2 } from "lucide-react";

function AppRoutes() {
  const { user } = useAuth();

  if (user === null) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-[#0B0F19]">
        <Loader2 className="w-8 h-8 animate-spin text-emerald-500" />
      </div>
    );
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={
          !user ? <Login /> : <Navigate to={user.role === "admin" ? "/admin" : "/"} replace />
        }
      />
      <Route
        path="/admin"
        element={
          !user ? <Navigate to="/login" replace /> : user.role === "admin" ? <Admin /> : <Navigate to="/" replace />
        }
      />
      <Route
        path="/"
        element={
          !user ? <Navigate to="/login" replace /> : user.role === "admin" ? <Navigate to="/admin" replace /> : <Worker />
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function App() {
  return (
    <div className="App">
      <LanguageProvider>
        <AuthProvider>
          <BrowserRouter>
            <AppRoutes />
            <Toaster position="top-center" theme="dark" richColors />
          </BrowserRouter>
        </AuthProvider>
      </LanguageProvider>
    </div>
  );
}

export default App;
