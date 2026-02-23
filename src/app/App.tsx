import "../styles/base/app.css";
import { AuthProvider } from "../auth/AuthProvider";
import AppRoutes from "../router/routes";

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
