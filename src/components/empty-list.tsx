import logo from '@/assets/favicon.png';

interface EmptyListProps {
    title?: string;
    description?: string;
    children?: React.ReactNode;
}

const EmptyList: React.FC<EmptyListProps> = ({ title, description, children }) => {
    return (
        <div className="flex flex-col items-center  gap-1  h-full  pt-[86px] main-linear-background rounded-lg">
            {
                <img
                    width={64}
                    src={logo}
                    alt="GoForge"
                />
            }
            {
                title &&
                <h1 className="text-font/90 font-bold text-md mt-2">
                    {title}
                </h1>
            }
            {
                description &&
                <p className="text-sm text-font/70">
                    {description}
                </p>
            }
            {children && <div className="mt-4">{children}</div>}
        </div>
    )
}


export default EmptyList;
