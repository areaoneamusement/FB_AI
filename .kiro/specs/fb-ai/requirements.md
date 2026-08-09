# Requirements Document

## Introduction

FB_AI là một nền tảng sản xuất và xuất bản nội dung tự động, hỗ trợ vận hành kênh nội dung (Facebook Page, Facebook Group, YouTube) với chủ đề công cụ AI, kỹ năng AI và các cập nhật mới từ những nguồn uy tín (repo GitHub điểm cao, trang công nghệ lớn, forum kỹ thuật).

Hệ thống hoạt động theo mô hình "con người phê duyệt" (human-in-the-loop): AI tự động dò nguồn, chấm điểm chủ đề, tổng hợp research, sinh nội dung (bài viết, cẩm nang kèm gợi ý hình ảnh, kịch bản video), rồi cho **hai mô hình AI kiểm chứng chéo** nhau về độ chính xác và chất lượng. Nội dung phải vượt qua bước kiểm tra tiêu chuẩn cộng đồng và bản quyền trước khi đưa vào bảng duyệt. Người vận hành chỉ cần xem lại và bấm phê duyệt; hệ thống chịu trách nhiệm xuất bản và hỗ trợ quản lý cộng đồng.

Tài liệu này mô tả yêu cầu ở mức "làm gì" (what), chưa mô tả "làm thế nào" (how). Do phạm vi lớn, các yêu cầu được nhóm theo năng lực để giai đoạn Design/Tasks có thể phân kỳ (ví dụ MVP trước, mở rộng sau).

## Glossary

- **FB_AI_System**: Toàn bộ nền tảng FB_AI, bao gồm các thành phần con dưới đây.
- **Source_Collector**: Thành phần dò và thu thập nội dung từ các nguồn (GitHub, trang web, forum).
- **Source_Registry**: Danh mục các nguồn được cấu hình để theo dõi, kèm quy tắc thu thập.
- **Topic**: Một chủ đề ứng viên được trích xuất từ nguồn (ví dụ một repo, một changelog, một tính năng mới).
- **Topic_Scorer**: Thành phần chấm điểm và xếp hạng các Topic theo tiêu chí độ liên quan và tiềm năng lan tỏa.
- **Research_Aggregator**: Thành phần tổng hợp thông tin chi tiết cho một Topic đã được chọn.
- **Content_Generator**: Thành phần sinh bản nháp nội dung (bài Facebook, cẩm nang, kịch bản video) từ dữ liệu research.
- **Content_Draft**: Một bản nháp nội dung với các định dạng đầu ra và metadata kèm theo.
- **Verification_Engine**: Thành phần điều phối hai mô hình AI (Model_A và Model_B) để kiểm chứng chéo Content_Draft.
- **Model_A / Model_B**: Hai mô hình AI độc lập; một tạo/đề xuất, một phản biện/kiểm tra và ngược lại.
- **Compliance_Checker**: Thành phần kiểm tra Content_Draft theo tiêu chuẩn cộng đồng của nền tảng đích và quy tắc bản quyền/điều khoản nguồn.
- **Content_Pipeline**: Quy trình tuần tự đưa nội dung qua các trạng thái (Stage) có thứ tự xác định.
- **Stage**: Một trạng thái trong Content_Pipeline (ví dụ: Collected, Scored, Researched, Generated, Verified, ComplianceChecked, PendingApproval, Approved, Published, Rejected).
- **Review_Dashboard**: Giao diện web để người vận hành xem, sửa, phê duyệt hoặc từ chối Content_Draft.
- **Operator**: Người vận hành kênh, có quyền phê duyệt và xuất bản nội dung.
- **Publisher**: Thành phần xuất bản nội dung đã phê duyệt lên nền tảng đích qua API chính thức.
- **Target_Platform**: Nền tảng đích để xuất bản (Facebook_Page, Facebook_Group, YouTube).
- **Group_Manager**: Thành phần hỗ trợ quản lý và tăng tương tác cho Facebook_Group.
- **Credential_Store**: Kho lưu trữ an toàn các thông tin xác thực và token truy cập nền tảng.
- **Publishing_Policy**: Điều khoản dịch vụ và giới hạn tần suất (rate limit) của Target_Platform.
- **Source_Terms**: Điều khoản sử dụng, giấy phép và robots.txt của nguồn được thu thập.

## Requirements

### Requirement 1: Thu thập nội dung từ nguồn

**User Story:** Là một Operator, tôi muốn hệ thống tự động dò các nguồn uy tín, để tôi luôn có sẵn nguyên liệu nội dung mới mà không phải tìm thủ công.

#### Acceptance Criteria

1. THE Source_Collector SHALL cho phép Operator cấu hình Source_Registry gồm ít nhất ba loại nguồn: kho GitHub, trang web công nghệ và forum kỹ thuật, với tối đa 500 nguồn cho mỗi loại.
2. WHEN một chu kỳ thu thập được kích hoạt, THE Source_Collector SHALL truy xuất từ mỗi nguồn đang được kích hoạt trong Source_Registry các mục nội dung có thời điểm đăng hoặc cập nhật nằm trong khoảng thời gian thu thập được cấu hình (từ 1 giờ đến 720 giờ, mặc định 24 giờ) tính đến thời điểm chu kỳ chạy.
3. WHILE truy xuất một nguồn đơn lẻ, THE Source_Collector SHALL áp dụng thời gian chờ tối đa 30 giây cho mỗi yêu cầu truy xuất tới nguồn đó.
4. WHEN Source_Collector thu thập từ một kho GitHub, THE Source_Collector SHALL ghi nhận số sao (star), thời điểm cập nhật gần nhất và nội dung changelog hoặc release mới nhất của kho đó.
5. IF một mục nội dung đã tồn tại trong hệ thống theo định danh nguồn, THEN THE Source_Collector SHALL bỏ qua mục đó và không tạo Topic trùng lặp.
6. IF Source_Terms của một nguồn cấm thu thập tự động hoặc robots.txt chặn đường dẫn, THEN THE Source_Collector SHALL bỏ qua nguồn đó và ghi lại bản ghi nêu rõ lý do bỏ qua cùng định danh nguồn.
7. IF một nguồn không truy xuất được sau số lần thử được cấu hình (từ 1 đến 5 lần, mặc định 3 lần), THEN THE Source_Collector SHALL ghi lại bản ghi lỗi nêu rõ định danh nguồn và nguyên nhân thất bại, giữ nguyên các mục đã thu thập trước đó, và tiếp tục thu thập các nguồn còn lại.

### Requirement 2: Chấm điểm và chọn chủ đề

**User Story:** Là một Operator, tôi muốn hệ thống xếp hạng các chủ đề theo mức độ hấp dẫn, để tôi ưu tiên làm nội dung có tiềm năng lan tỏa cao.

#### Acceptance Criteria

1. WHEN một Topic mới được tạo, THE Topic_Scorer SHALL gán cho Topic một điểm số dạng số thực nằm trong khoảng từ 0 đến 100 (bao gồm cả hai đầu mút) trong vòng tối đa 5 giây kể từ thời điểm Topic được tạo.
2. THE Topic_Scorer SHALL tính điểm là tổng có trọng số của các tiêu chí đã cấu hình gồm độ mới, độ uy tín của nguồn và mức độ liên quan tới chủ đề AI, trong đó mỗi tiêu chí đóng góp một giá trị thành phần từ 0 đến 100 và tổng các trọng số bằng 100 phần trăm.
3. WHEN Operator yêu cầu danh sách Topic, THE Topic_Scorer SHALL trả về các Topic được sắp xếp giảm dần theo điểm số, và với các Topic có cùng điểm số THE Topic_Scorer SHALL sắp xếp theo thời điểm tạo mới hơn trước.
4. WHERE Operator đã đặt ngưỡng điểm tối thiểu là một giá trị từ 0 đến 100, THE Topic_Scorer SHALL chỉ chuyển sang bước tiếp theo những Topic có điểm số lớn hơn hoặc bằng ngưỡng đó.
5. THE Topic_Scorer SHALL lưu lại giá trị thành phần và trọng số của từng tiêu chí cấu thành điểm số cho mỗi Topic để Operator xem được lý do xếp hạng.
6. IF không thể tính điểm cho một Topic do thiếu dữ liệu đầu vào của một hoặc nhiều tiêu chí, THEN THE Topic_Scorer SHALL gán cho Topic trạng thái chưa chấm điểm, không đưa Topic đó vào bước tiếp theo, và ghi lại chỉ báo lý do không tính được điểm để Operator xem.

### Requirement 3: Tổng hợp research cho chủ đề

**User Story:** Là một Operator, tôi muốn hệ thống tổng hợp thông tin chi tiết cho một chủ đề đã chọn, để nội dung sinh ra chính xác và đầy đủ ngữ cảnh.

#### Acceptance Criteria

1. WHEN một Topic được chọn để sản xuất nội dung, THE Research_Aggregator SHALL tổng hợp thông tin cho Topic đó từ nguồn gốc và các nguồn liên quan được phép truy cập, và hoàn tất trong vòng 60 giây.
2. WHEN quá trình tổng hợp cho một Topic hoàn tất, THE Research_Aggregator SHALL lưu kèm mỗi mục thông tin đã tổng hợp một tham chiếu tới nguồn gốc của mục thông tin đó.
3. WHEN quá trình tổng hợp cho một Topic hoàn tất, THE Research_Aggregator SHALL gán cho mỗi mục thông tin một nhãn phân loại cho biết mục đó được trích từ nguồn hay do mô hình suy luận.
4. IF số mục thông tin tổng hợp được cho một Topic nhỏ hơn ngưỡng tối thiểu đã cấu hình (mặc định 3 mục), THEN THE Research_Aggregator SHALL đánh dấu Topic đó là "thiếu dữ liệu", không chuyển Topic sang bước sinh nội dung, và ghi lại chỉ báo lý do là thiếu dữ liệu.
5. IF một nguồn được phép truy cập không phản hồi trong vòng 15 giây hoặc trả về lỗi, THEN THE Research_Aggregator SHALL bỏ qua nguồn đó, tiếp tục tổng hợp từ các nguồn còn lại, và ghi lại chỉ báo về nguồn không truy cập được.
6. IF không truy cập được nguồn gốc của Topic, THEN THE Research_Aggregator SHALL đánh dấu Topic đó là "thiếu dữ liệu", không chuyển Topic sang bước sinh nội dung, và ghi lại chỉ báo lý do là không truy cập được nguồn gốc.

### Requirement 4: Sinh nội dung đa định dạng

**User Story:** Là một Operator, tôi muốn hệ thống tạo bản nháp nội dung ở nhiều định dạng, để tôi có đủ nguyên liệu cho cả Facebook và YouTube từ một chủ đề.

#### Acceptance Criteria

1. WHEN một Topic đã hoàn tất bước research, THE Content_Generator SHALL tạo một Content_Draft gồm ít nhất ba định dạng: một bài đăng Facebook (độ dài từ 50 đến 5.000 ký tự), một cẩm nang hướng dẫn có cấu trúc gồm ít nhất ba phần chính, và một kịch bản video YouTube gồm ít nhất một phần mở đầu, phần nội dung chính và phần kết.
2. WHEN tạo Content_Draft, THE Content_Generator SHALL đưa vào ít nhất một gợi ý hình ảnh minh họa kèm mô tả dài từ 10 đến 500 ký tự cho mỗi phần chính của cẩm nang hướng dẫn.
3. WHEN tạo Content_Draft, THE Content_Generator SHALL đưa vào Content_Draft ít nhất một liên kết tới nguồn gốc của Topic.
4. WHERE Operator đã cấu hình văn phong (brand voice), THE Content_Generator SHALL tạo nội dung theo văn phong đã cấu hình đó.
5. WHERE Operator không cấu hình ngôn ngữ khác, THE Content_Generator SHALL viết toàn bộ Content_Draft bằng tiếng Việt.
6. IF việc tạo Content_Draft thất bại đối với một hoặc nhiều định dạng, THEN THE Content_Generator SHALL giữ nguyên trạng thái đã hoàn tất research của Topic và cung cấp thông báo lỗi cho biết định dạng nào không tạo được.

### Requirement 5: Kiểm chứng chéo bằng hai mô hình

**User Story:** Là một Operator không có chuyên môn kỹ thuật, tôi muốn hai mô hình AI tự kiểm tra lẫn nhau, để giảm sai sót mà không cần tôi kiểm chứng thủ công từng chi tiết.

#### Acceptance Criteria

1. WHEN một Content_Draft đạt trạng thái Generated, THE Verification_Engine SHALL để Model_B phản biện toàn bộ nội dung do Model_A tạo.
2. WHEN Model_B phản biện một Content_Draft, THE Verification_Engine SHALL kiểm tra từng phát biểu trong Content_Draft có nhất quán với thông tin đã tổng hợp ở bước research hay không.
3. IF Verification_Engine phát hiện một phát biểu trong Content_Draft mâu thuẫn với thông tin từ nguồn research, THEN THE Verification_Engine SHALL đánh dấu phát biểu đó là "mâu thuẫn", ghi lại tham chiếu tới nguồn research liên quan và mô tả nội dung mâu thuẫn.
4. WHEN Model_B hoàn tất phản biện một Content_Draft, THE Verification_Engine SHALL tạo báo cáo kiểm chứng liệt kê từng phát biểu đã kiểm tra kèm kết luận "đạt" hoặc "mâu thuẫn" cho mỗi phát biểu.
5. WHEN một Content_Draft không còn phát biểu nào bị đánh dấu "mâu thuẫn", THE Verification_Engine SHALL chuyển Content_Draft sang trạng thái Verified.
6. IF một Content_Draft còn tồn tại ít nhất một phát biểu bị đánh dấu "mâu thuẫn" sau số vòng chỉnh sửa được cấu hình (từ 1 đến 5 vòng, mặc định 2 vòng), THEN THE Verification_Engine SHALL chuyển Content_Draft sang trạng thái cần Operator xử lý thủ công thay vì tự phê duyệt.
7. IF Model_A hoặc Model_B không phản hồi sau số lần thử được cấu hình (tối đa 3 lần), THEN THE Verification_Engine SHALL giữ Content_Draft ở trạng thái Generated, ghi lại lỗi kèm lý do thất bại và thông báo cho Operator.
8. THE Verification_Engine SHALL lưu báo cáo kiểm chứng kèm theo Content_Draft để Operator xem được.

### Requirement 6: Kiểm tra tiêu chuẩn cộng đồng và bản quyền

**User Story:** Là một Operator, tôi muốn hệ thống kiểm tra nội dung theo tiêu chuẩn cộng đồng và bản quyền, để tránh bị nền tảng phạt hoặc gỡ nội dung.

#### Acceptance Criteria

1. WHEN một Content_Draft chuyển sang bước kiểm tra tuân thủ, THE Compliance_Checker SHALL đánh giá Content_Draft theo toàn bộ quy tắc tiêu chuẩn cộng đồng đã cấu hình cho mỗi Target_Platform và hoàn tất việc đánh giá trong vòng 30 giây cho mỗi Target_Platform.
2. IF Content_Draft vi phạm ít nhất một quy tắc tiêu chuẩn cộng đồng, THEN THE Compliance_Checker SHALL đánh dấu Content_Draft là "không đạt" và ghi lại danh sách đầy đủ các quy tắc bị vi phạm kèm định danh của từng quy tắc.
3. WHEN Compliance_Checker đánh giá một Content_Draft, THE Compliance_Checker SHALL kiểm tra Content_Draft có ghi công (attribution) tới nguồn gốc theo Source_Terms.
4. IF Content_Draft thiếu phần ghi công bắt buộc theo Source_Terms, THEN THE Compliance_Checker SHALL đánh dấu Content_Draft là "không đạt" và nêu rõ yêu cầu ghi công chưa được đáp ứng.
5. IF Content_Draft sao chép nguyên văn từ một nguồn vượt quá giới hạn được cấu hình (mặc định 50 từ liên tiếp hoặc 20% tổng số từ của Content_Draft, tùy điều kiện nào đạt trước), THEN THE Compliance_Checker SHALL đánh dấu Content_Draft là "không đạt" và nêu rõ lý do rủi ro bản quyền.
6. WHEN Compliance_Checker hoàn tất kiểm tra một Content_Draft, THE Compliance_Checker SHALL lưu kết quả kiểm tra tuân thủ (kết quả đạt hoặc không đạt, danh sách quy tắc vi phạm, kết quả kiểm tra ghi công và kết quả kiểm tra bản quyền) kèm theo Content_Draft.
7. IF cấu hình tiêu chuẩn cộng đồng hoặc Source_Terms cho một Target_Platform không khả dụng tại thời điểm kiểm tra, THEN THE Compliance_Checker SHALL đánh dấu Content_Draft là "không đạt", cung cấp thông báo lỗi cho biết cấu hình kiểm tra không khả dụng, và giữ nguyên nội dung Content_Draft.

### Requirement 7: Quy trình pipeline tuần tự và phân loại

**User Story:** Là một Operator, tôi muốn nội dung đi qua các bước rõ ràng và được phân loại, để tôi luôn biết mỗi nội dung đang ở giai đoạn nào.

#### Acceptance Criteria

1. THE Content_Pipeline SHALL chuyển mỗi Content_Draft qua các Stage theo đúng thứ tự: Collected → Scored → Researched → Generated → Verified → ComplianceChecked → PendingApproval → Approved → Published, và không cho phép bỏ qua bất kỳ Stage nào trong thứ tự này.
2. WHEN một Content_Draft hoàn tất một Stage thành công, THE Content_Pipeline SHALL chuyển Content_Draft sang đúng Stage kế tiếp liền kề trong thứ tự đã định trong vòng tối đa 5 giây kể từ thời điểm hoàn tất, và cập nhật thuộc tính Stage hiện tại của Content_Draft thành Stage kế tiếp đó.
3. IF một Content_Draft không đạt tại một Stage, THEN THE Content_Pipeline SHALL chuyển Content_Draft sang Stage "Rejected", lưu lại lý do không đạt dưới dạng chuỗi văn bản không rỗng có độ dài từ 1 đến 500 ký tự cùng với định danh của Stage nơi xảy ra lỗi, giữ nguyên (không xóa) dữ liệu Content_Draft đã có, và đánh dấu Content_Draft ở trạng thái quan sát được là "Rejected".
4. THE Content_Pipeline SHALL gán cho mỗi Topic tối thiểu 1 và tối đa 5 hạng mục (category) chủ đề được chọn từ tập danh mục đã định nghĩa trước trong hệ thống, để phục vụ lọc và sắp xếp.
5. WHILE một Content_Draft đang ở một trong các Stage tự động (Scored, Researched, Generated, Verified, ComplianceChecked), THE Content_Pipeline SHALL từ chối mọi yêu cầu xuất bản Content_Draft đó và trả về chỉ báo lỗi cho biết Content_Draft chưa được phê duyệt.
6. WHILE một Content_Draft đang ở Stage "PendingApproval", THE Content_Pipeline SHALL chỉ chuyển Content_Draft sang Stage "Approved" khi nhận được hành động phê duyệt tường minh từ Operator, và trong mọi trường hợp khác SHALL giữ Content_Draft ở Stage "PendingApproval".
7. IF một Content_Draft ở một Stage tự động không hoàn tất trong vòng 300 giây, THEN THE Content_Pipeline SHALL chuyển Content_Draft sang Stage "Rejected", lưu lý do không đạt là hết thời gian xử lý cùng định danh Stage tương ứng, và trả về chỉ báo lỗi cho biết Stage đã hết thời gian xử lý.

### Requirement 8: Bảng duyệt và phê duyệt của con người

**User Story:** Là một Operator, tôi muốn một bảng điều khiển để xem và phê duyệt nội dung, để tôi chỉ cần thao tác tối thiểu trước khi nội dung được xuất bản.

#### Acceptance Criteria

1. WHEN một Content_Draft đạt trạng thái PendingApproval, THE Review_Dashboard SHALL hiển thị trong vòng 5 giây Content_Draft đó cùng báo cáo kiểm chứng và kết quả kiểm tra tuân thủ.
2. WHILE một Content_Draft ở trạng thái PendingApproval, THE Review_Dashboard SHALL cho phép Operator chỉnh sửa nội dung của Content_Draft với độ dài tối đa 5.000 ký tự trước khi phê duyệt.
3. WHEN Operator phê duyệt một Content_Draft, THE Review_Dashboard SHALL chuyển Content_Draft sang trạng thái Approved.
4. WHEN Operator từ chối một Content_Draft kèm ghi chú có độ dài từ 1 đến 1.000 ký tự, THE Review_Dashboard SHALL chuyển Content_Draft sang trạng thái Rejected và lưu ghi chú của Operator.
5. IF Operator từ chối một Content_Draft mà không nhập ghi chú hoặc ghi chú vượt quá 1.000 ký tự, THEN THE Review_Dashboard SHALL từ chối thao tác, giữ nguyên trạng thái hiện tại của Content_Draft và hiển thị thông báo lỗi cho biết ghi chú không hợp lệ.
6. THE FB_AI_System SHALL yêu cầu Operator phê duyệt trước khi bất kỳ Content_Draft nào được xuất bản.
7. IF một Content_Draft chưa ở trạng thái Approved, THEN THE FB_AI_System SHALL ngăn không cho xuất bản Content_Draft đó và hiển thị thông báo lỗi cho biết nội dung chưa được phê duyệt.
8. WHEN Operator chỉnh sửa rồi lưu một Content_Draft, THE Review_Dashboard SHALL bảo toàn nội dung đã lưu sao cho khi tải lại Content_Draft hiển thị đúng nội dung vừa lưu.
9. IF việc lưu nội dung Content_Draft đã chỉnh sửa thất bại, THEN THE Review_Dashboard SHALL giữ nguyên nội dung trước khi chỉnh sửa và hiển thị thông báo lỗi cho biết thao tác lưu không thành công.

### Requirement 9: Xuất bản lên nền tảng đích

**User Story:** Là một Operator, tôi muốn hệ thống tự xuất bản nội dung đã phê duyệt, để tôi không phải đăng thủ công lên từng nền tảng.

#### Acceptance Criteria

1. WHEN một Content_Draft đạt trạng thái Approved và được chỉ định Target_Platform, THE Publisher SHALL bắt đầu xuất bản nội dung đúng định dạng của Target_Platform đó qua API chính thức của nền tảng trong vòng 60 giây.
2. THE Publisher SHALL sử dụng bài đăng Facebook cho Facebook_Page và Facebook_Group, và sử dụng kịch bản video cùng metadata cho YouTube.
3. IF việc xuất bản thất bại, THEN THE Publisher SHALL thử lại tối đa 3 lần cách nhau tối thiểu 30 giây, giữ Content_Draft ở trạng thái Approved, ghi lại lỗi kèm thời điểm và lý do do Target_Platform trả về, thông báo chỉ báo lỗi cho Operator, và không đánh dấu Content_Draft là Published.
4. WHEN xuất bản thành công, THE Publisher SHALL lưu định danh và liên kết bài đăng do Target_Platform trả về vào Content_Draft.
5. WHEN Publisher đã lưu định danh và liên kết bài đăng cho một Content_Draft, THE Publisher SHALL chuyển Content_Draft sang trạng thái Published.
6. WHILE tần suất xuất bản chạm giới hạn Publishing_Policy của một Target_Platform, THE Publisher SHALL hoãn các lần xuất bản tiếp theo tới nền tảng đó, ghi lại thời điểm dự kiến thử lại, và tự động tiếp tục xuất bản khi tần suất trở lại trong giới hạn.

### Requirement 10: Quản lý và tăng tương tác nhóm Facebook

**User Story:** Là một Operator, tôi muốn hỗ trợ vận hành nhóm Facebook, để tăng gắn kết với khách hàng và người hâm mộ.

#### Acceptance Criteria

1. WHERE tính năng quản lý nhóm được bật, WHEN đến thời điểm đã cấu hình trong lịch đăng bài, THE Group_Manager SHALL đăng nội dung đã phê duyệt lên Facebook_Group trong vòng 60 giây kể từ thời điểm theo lịch.
2. IF việc đăng nội dung đã lên lịch lên Facebook_Group thất bại, THEN THE Group_Manager SHALL giữ nguyên nội dung ở trạng thái chưa đăng, thử lại tối đa 3 lần cách nhau 60 giây, và thông báo cho Operator chỉ báo lỗi cho biết nội dung chưa được đăng.
3. WHEN có bình luận mới trong Facebook_Group, THE Group_Manager SHALL soạn bản nháp phản hồi trong vòng 30 giây và đặt bản nháp ở trạng thái chờ Operator phê duyệt trước khi gửi.
4. THE FB_AI_System SHALL yêu cầu Operator phê duyệt trước khi Group_Manager gửi bất kỳ phản hồi nào tới thành viên nhóm.
5. IF Operator không phê duyệt bản nháp phản hồi trong vòng 24 giờ kể từ khi bản nháp được tạo, THEN THE Group_Manager SHALL giữ bản nháp ở trạng thái chờ và không gửi phản hồi cho đến khi được Operator phê duyệt.
6. WHEN Operator mở bảng chỉ số tương tác, THE Group_Manager SHALL cung cấp các chỉ số tương tác của nhóm trong khoảng thời gian 30 ngày gần nhất gồm số bài đăng, số bình luận và số phản hồi đã gửi, với giá trị được cập nhật tối thiểu mỗi 60 phút một lần.

### Requirement 11: Quản lý thông tin xác thực an toàn

**User Story:** Là một Operator, tôi muốn thông tin xác thực nền tảng được lưu an toàn, để tài khoản kênh không bị lộ hoặc lạm dụng.

#### Acceptance Criteria

1. THE Credential_Store SHALL lưu thông tin xác thực và token của mỗi Target_Platform ở dạng đã mã hóa khi lưu trữ (at rest), và SHALL không lưu bất kỳ giá trị token hoặc mật khẩu nào ở dạng văn bản thuần (plaintext).
2. WHEN hiển thị thông tin xác thực trên Review_Dashboard, THE FB_AI_System SHALL che toàn bộ giá trị token, chỉ hiển thị định danh của thông tin xác thực và tối đa 4 ký tự cuối của token.
3. IF một token truy cập hết hạn hoặc bị thu hồi, THEN THE Publisher SHALL dừng xuất bản tới Target_Platform tương ứng trong vòng tối đa 5 giây, giữ nguyên (không mất) nội dung đang chờ xuất bản, và thông báo cho Operator bằng thông báo nêu rõ Target_Platform cần được cấp lại quyền.
4. WHEN Publisher nhận phản hồi từ Target_Platform cho biết token không hợp lệ hoặc bị từ chối xác thực, THE FB_AI_System SHALL đánh dấu thông tin xác thực tương ứng ở trạng thái "cần cấp lại quyền" và SHALL không thử lại quá 3 lần liên tiếp với cùng token đó.
5. WHEN Operator khởi tạo một hành động ghi ra bên ngoài (đăng bài, gửi phản hồi) tới Target_Platform, THE FB_AI_System SHALL yêu cầu Operator xác nhận trước khi thực hiện hành động đó.
6. IF Operator không xác nhận hành động ghi ra bên ngoài trong vòng 300 giây, THEN THE FB_AI_System SHALL hủy hành động, không gửi bất kỳ dữ liệu nào tới Target_Platform, và giữ nguyên nội dung ở trạng thái chờ xác nhận.
