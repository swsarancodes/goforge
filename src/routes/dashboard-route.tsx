
import Dashboard from '@/features/dashboard/';
import { Navigate, Route } from 'react-router-dom';
import useDatabaseRoutes from './database-route';
import DataBrowserPage from '@/features/data-browser';



const useDashboardRoutes = () => {
    const databaseRoutes = useDatabaseRoutes();
    return (
        <Route path="" element={<Dashboard />}>
            <Route index element={<Navigate to="database" replace />} />
            {databaseRoutes}
            {/* Full-width page (no diagram): table list on the left, rows on the right. */}
            <Route path="/database/data" element={<DataBrowserPage />} />
        </Route>

    );
};

export default useDashboardRoutes;