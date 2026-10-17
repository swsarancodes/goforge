import { EnterpriseSampleQuery } from "./types";

export const ENTERPRISE_SAMPLE_QUERIES: EnterpriseSampleQuery[] = [
    {
        id: "oracle-hr-hierarchy",
        title: "Oracle ERP: Organizational Hierarchy & Benefits",
        description: "Legacy Oracle 11g HR query with hierarchical tree recursion, (+) outer join syntax, NVL, DECODE, and ROWNUM pagination.",
        sourceDialect: "oracle",
        targetDialect: "postgresql",
        highlightedChallenges: [
            "CONNECT BY PRIOR parent-child hierarchy",
            "Archaic (+) outer join syntax",
            "NVL() and DECODE() vendor functions",
            "Non-standard ROWNUM pagination",
            "SYSDATE date references"
        ],
        legacySql: `-- Oracle 11g Enterprise HR & Benefits Query
SELECT 
    e.emp_id,
    e.first_name || ' ' || e.last_name AS employee_name,
    NVL(e.salary, 0) AS base_salary,
    DECODE(e.status, 'A', 'Active', 'L', 'On Leave', 'T', 'Terminated', 'Unknown') AS status_desc,
    d.department_name,
    m.first_name || ' ' || m.last_name AS manager_name,
    LEVEL AS hierarchy_depth,
    SYS_CONNECT_BY_PATH(e.last_name, ' / ') AS management_chain,
    NVL(b.benefit_plan_name, 'No Plan Enrolled') AS current_benefit
FROM 
    EMP_MSTR e,
    DEPT_MSTR d,
    EMP_MSTR m,
    BENEFIT_ENROLLMENT b
WHERE 
    e.dept_id = d.dept_id (+)
    AND e.manager_id = m.emp_id (+)
    AND e.emp_id = b.emp_id (+)
    AND b.coverage_end_date (+) >= SYSDATE
START WITH 
    e.manager_id IS NULL
CONNECT BY PRIOR 
    e.emp_id = e.manager_id
ORDER SIBLINGS BY 
    e.last_name;`
    },
    {
        id: "mssql-sales-reporting",
        title: "SQL Server (T-SQL): Sales Intelligence & Lateral Apply",
        description: "Legacy T-SQL reporting query featuring CROSS APPLY, TOP limits, ISNULL, square bracket identifiers, and non-SARGable date filters.",
        sourceDialect: "mssql",
        targetDialect: "postgresql",
        highlightedChallenges: [
            "CROSS APPLY correlated subquery",
            "Non-SARGable WHERE YEAR([OrderDate]) = 2024",
            "ISNULL() vendor null-handling",
            "TOP (50) pagination instead of LIMIT",
            "T-SQL square bracket identifier syntax"
        ],
        legacySql: `-- Microsoft SQL Server 2012 T-SQL Analytics Report
SELECT TOP (50)
    c.[CustomerID],
    c.[CompanyName],
    ISNULL(c.[Region], 'Unassigned') AS [CustomerRegion],
    o.[TotalOrders],
    o.[TotalRevenue],
    latest.[OrderID] AS [MostRecentOrderID],
    latest.[OrderDate] AS [MostRecentOrderDate],
    latest.[OrderAmount] AS [MostRecentAmount]
FROM 
    [dbo].[Customers] c
INNER JOIN (
    SELECT 
        [CustomerID],
        COUNT([OrderID]) AS [TotalOrders],
        SUM([TotalAmount]) AS [TotalRevenue]
    FROM 
        [dbo].[Orders]
    WHERE 
        YEAR([OrderDate]) = 2024
    GROUP BY 
        [CustomerID]
) o ON c.[CustomerID] = o.[CustomerID]
CROSS APPLY (
    SELECT TOP (1) 
        sub.[OrderID],
        sub.[OrderDate],
        sub.[TotalAmount] AS [OrderAmount]
    FROM 
        [dbo].[Orders] sub
    WHERE 
        sub.[CustomerID] = c.[CustomerID]
    ORDER BY 
        sub.[OrderDate] DESC
) latest
WHERE 
    ISNULL(c.[IsActive], 1) = 1
ORDER BY 
    o.[TotalRevenue] DESC;`
    },
    {
        id: "finance-billing-antipatterns",
        title: "Legacy Financial Billing: Anti-Patterns & Subqueries",
        description: "Enterprise billing query plagued by hazardous NOT IN (NULL trap), correlated scalar subqueries in SELECT list, and Cartesian comma joins.",
        sourceDialect: "mysql",
        targetDialect: "postgresql",
        highlightedChallenges: [
            "Hazardous NOT IN subquery (NULL trap vulnerability)",
            "Correlated scalar subquery in SELECT projection",
            "Implicit Cartesian comma-join syntax",
            "Missing compound indexes on customer transactions",
            "IFNULL() vendor function"
        ],
        legacySql: `-- Legacy Financial Ledger & Billing Risk Report
SELECT 
    acc.account_number,
    acc.account_holder,
    IFNULL(acc.credit_limit, 5000.00) AS credit_limit,
    (
        SELECT AVG(tx.amount) 
        FROM transactions tx 
        WHERE tx.account_id = acc.id
    ) AS avg_transaction_value,
    COUNT(t.id) AS total_past_due_invoices,
    SUM(t.outstanding_amount) AS total_unpaid_balance
FROM 
    billing_accounts acc,
    invoices t
WHERE 
    acc.id = t.account_id
    AND t.status = 'PAST_DUE'
    AND acc.id NOT IN (
        SELECT delinquent_ref_id 
        FROM bankruptcy_exclusions 
        WHERE is_waived = 0
    )
GROUP BY 
    acc.id,
    acc.account_number,
    acc.account_holder,
    acc.credit_limit
HAVING 
    SUM(t.outstanding_amount) > 1000.00
ORDER BY 
    total_unpaid_balance DESC;`
    }
];
