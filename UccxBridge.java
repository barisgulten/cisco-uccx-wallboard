import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Statement;
import java.util.Properties;
import java.util.regex.Pattern;

public class UccxBridge {
    private static final Pattern HOST_PATTERN = Pattern.compile("^[A-Za-z0-9._-]{1,253}$");
    private static final Pattern IDENT_PATTERN = Pattern.compile("^[A-Za-z0-9_]{1,128}$");

    private static String envTrimmed(String name) {
        String val = System.getenv(name);
        return val == null ? "" : val.trim();
    }

    private static String jsonEscape(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '\\': sb.append("\\\\"); break;
                case '"': sb.append("\\\""); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        return sb.toString();
    }

    private static void appendResultSetRows(StringBuilder json, Connection conn, String sql) throws Exception {
        json.append("[");
        try (Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(sql)) {
            ResultSetMetaData meta = rs.getMetaData();
            int colCount = meta.getColumnCount();
            boolean firstRow = true;
            while (rs.next()) {
                if (!firstRow) json.append(",");
                firstRow = false;
                json.append("{");
                for (int i = 1; i <= colCount; i++) {
                    if (i > 1) json.append(",");
                    String col = meta.getColumnName(i).toLowerCase();
                    Object val = rs.getObject(i);
                    json.append("\"").append(jsonEscape(col)).append("\":");
                    if (val == null) {
                        json.append("null");
                    } else if (val instanceof Number || val instanceof Boolean) {
                        json.append(val.toString());
                    } else {
                        json.append("\"").append(jsonEscape(val.toString().trim())).append("\"");
                    }
                }
                json.append("}");
            }
        }
        json.append("]");
    }

    public static void main(String[] args) {
        String host = envTrimmed("UCCX_DB_HOST");
        String portStr = envTrimmed("UCCX_DB_PORT");
        String server = envTrimmed("UCCX_DB_SERVER");
        String db = envTrimmed("UCCX_DB_NAME");
        String user = envTrimmed("UCCX_DB_USER");
        String pass = System.getenv("UCCX_DB_PASS");

        if (host.isEmpty() || portStr.isEmpty() || server.isEmpty() || db.isEmpty()
                || user.isEmpty() || pass == null || pass.isEmpty()) {
            System.out.println("{\"success\":false,\"error\":\"Missing database configuration\"}");
            return;
        }

        int portNum;
        try {
            portNum = Integer.parseInt(portStr);
        } catch (NumberFormatException e) {
            System.out.println("{\"success\":false,\"error\":\"Invalid database connection parameters\"}");
            return;
        }

        if (!HOST_PATTERN.matcher(host).matches()
                || portNum < 1 || portNum > 65535
                || !IDENT_PATTERN.matcher(server).matches()
                || !IDENT_PATTERN.matcher(db).matches()) {
            System.out.println("{\"success\":false,\"error\":\"Invalid database connection parameters\"}");
            return;
        }

        String url = "jdbc:informix-sqli://" + host + ":" + portNum + "/" + db + ":INFORMIXSERVER=" + server;
        Properties props = new Properties();
        props.setProperty("user", user);
        props.setProperty("password", pass);

        StringBuilder json = new StringBuilder();
        json.append("{");

        try {
            Class.forName("com.informix.jdbc.IfxDriver");
            DriverManager.setLoginTimeout(3);
            try (Connection conn = DriverManager.getConnection(url, props)) {
                json.append("\"success\":true,");
                json.append("\"host\":\"").append(jsonEscape(host)).append("\",");
                json.append("\"port\":").append(portNum).append(",");
                json.append("\"server\":\"").append(jsonEscape(server)).append("\",");

                json.append("\"csqRows\":");
                appendResultSetRows(json, conn, "SELECT * FROM rtcsqssummary");
                json.append(",");

                json.append("\"icdRows\":");
                appendResultSetRows(json, conn, "SELECT * FROM rticdstatistics");
            }
        } catch (Exception e) {
            String errMsg = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
            json.setLength(1);
            json.append("\"success\":false,");
            json.append("\"error\":\"").append(jsonEscape(errMsg)).append("\"");
        }

        json.append("}");
        System.out.println(json.toString());
    }
}
