
import Dashboard from '@/features/dashboard/';
import { Navigate, Route } from 'react-router-dom';
import useDatabaseRoutes from './database-route';
import DataBrowserPage from '@/features/data-browser';
import QueryModernizerPage from '@/features/query-modernizer';



const useDashboardRoutes = () => {
    const databaseRoutes = useDatabaseRoutes();
    return (
        <Route path="" element={<Dashboard />}>
            <Route index element={<Navigate to="database" replace />} />
            {databaseRoutes}
            {/* Full-width page (no diagram): table list on the left, rows on the right. */}
            <Route path="/database/data" element={<DataBrowserPage />} />
            <Route path="/database/modernizer" element={<QueryModernizerPage />} />
        </Route>

    );
};

export default useDashboardRoutes;