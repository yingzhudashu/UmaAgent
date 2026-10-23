# 文档解析回归夹具

四个原生样本分别由 python-docx、openpyxl、python-pptx 和 reportlab 生成，仅包含对应格式的公开验收标记，不含用户数据。document-integration.test.ts 使用发布构建的真实 Worker 解析，验证 DOCX/XLSX/PPTX/PDF 支持；不能用 mock Worker 测试代替。
