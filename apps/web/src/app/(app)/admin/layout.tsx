import { AdminOnly } from "@/components/admin/AdminOnly";

const AdminLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <AdminOnly>{children}</AdminOnly>
);

export default AdminLayout;
